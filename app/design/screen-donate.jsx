/* global React */
// HYPHA · W8.4 Donate surface (BLUEPRINT §19.2).
//
// Tier ladder (4) + legal disclaimer (固定 LEGAL_TEXT 来自 lib/donate)
// + 用户 donate 记录. Stripe / WeChat Pay 真实接管不在此屏 — record button
// 写入 vault ledger, payment_ref 由后续 payment-rails 适配器回填.
//
// intentional-placeholder: the only deferred surface here is the payment-rails
// confirmation roundtrip, kept on the lib side `donate.recordDonation()`
// returning `status: 'pending_payment'`. The UI flow + ledger write is fully
// implemented end-to-end against `window.ptor.donate.*`.
//
// Props: { userId, onBack }

const { useState, useEffect, useCallback, useMemo } = React;

const FieldLabel = ({ children }) => (
  <div style={{
    fontFamily: 'EB Garamond, serif',
    fontStyle: 'italic',
    fontSize: 13,
    color: 'var(--ink-3, #8b8275)',
    letterSpacing: '0.06em',
    marginBottom: 6,
  }}>{children}</div>
);

const Hairline = () => (
  <div style={{
    height: 1, background: 'var(--rule-soft, #e3dccd)',
    margin: '20px 0',
  }} />
);

// 2026-05-13 — 4-tier card grid retired. Donations now freeform ≥ ¥0.1
// (MIN_DONATION_CNY in app/lib/donate/donate.js; renderer mirrors the
// constant so a single-source-of-truth IPC isn't required for a number).
// Suggestion pills feed the amount input but never lock it; backend resolves
// matched-perk-tier from the actual amount.
const MIN_DONATION_CNY = 0.1;

// _resolvePerksFromAmount — UI-side mirror of donate.js _resolvePerksByAmount,
// so the perk preview reacts as the user types (no IPC roundtrip per keystroke).
// `tiers` is the array returned by donate.tiers() IPC; descending-match retained.
const _resolvePerksFromAmount = (amount, tiers) => {
  if (!Number.isFinite(amount) || amount < MIN_DONATION_CNY) return null;
  if (!Array.isArray(tiers) || tiers.length === 0) return null;
  let matched = null;
  for (const t of tiers) {
    if (amount >= t.amount_cny) matched = t;
  }
  return matched;
};

const SUGGESTION_PILLS = [1, 10, 100, 500];

const DonateScreen = ({ userId, onBack }) => {
  const [tiers, setTiers] = useState([]);
  const [amountStr, setAmountStr] = useState('');
  const [legal, setLegal] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [my, setMy] = useState([]);
  const [recorded, setRecorded] = useState(null);

  const effectiveUser = userId || 'local';

  // Parse the user input once; downstream guards re-check the same value.
  const amount = useMemo(() => {
    const trimmed = (amountStr || '').trim();
    if (!trimmed) return NaN;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : NaN;
  }, [amountStr]);

  const matched = useMemo(() => _resolvePerksFromAmount(amount, tiers), [amount, tiers]);

  const reload = useCallback(async () => {
    if (!window.ptor || !window.ptor.donate) return;
    try {
      const r = await window.ptor.donate.list({ userId: effectiveUser });
      if (r && r.ok) setMy(r.items || []);
    } catch (_) {}
  }, [effectiveUser]);

  useEffect(() => {
    (async () => {
      if (!window.ptor || !window.ptor.donate) return;
      try {
        const t = await window.ptor.donate.tiers();
        if (t && t.ok && Array.isArray(t.tiers)) {
          setTiers(t.tiers);
        }
        const l = await window.ptor.donate.legal();
        if (l && l.ok) setLegal(l.text || '');
      } catch (_) {}
    })();
    reload();
  }, [reload]);

  const onRecord = async () => {
    setError(null);
    if (!Number.isFinite(amount) || amount < MIN_DONATION_CNY) {
      setError(`金额至少 ¥${MIN_DONATION_CNY}。`);
      return;
    }
    if (!window.ptor || !window.ptor.donate) { setError('IPC bridge missing。'); return; }
    setBusy(true);
    try {
      const hint = matched ? matched.tier_name : null;
      const r = await window.ptor.donate.record(effectiveUser, amount, hint);
      if (!r || !r.ok) {
        setError(r && r.error ? r.error : '记录失败。');
      } else {
        setRecorded(r.record);
        await reload();
      }
    } catch (e) { setError(String(e && e.message || e)); }
    finally { setBusy(false); }
  };

  return (
    <div style={{
      maxWidth: 980, margin: '0 auto', padding: '32px 28px',
      fontFamily: '"Noto Serif SC", "EB Garamond", serif',
      color: 'var(--ink-1, #2c2620)',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 4 }}>
        <div style={{ fontFamily: 'EB Garamond, serif', fontStyle: 'italic', fontSize: 26 }}>
          赞助 — donate
        </div>
        <button onClick={onBack} style={{
          background: 'none', border: 'none', cursor: 'pointer',
          color: 'var(--ink-3, #8b8275)', fontStyle: 'italic',
          fontFamily: 'EB Garamond, serif', fontSize: 14,
        }}>返回</button>
      </div>
      <div style={{ fontSize: 14, color: 'var(--ink-3, #8b8275)', fontStyle: 'italic', marginBottom: 24 }}>
        BLUEPRINT §19.2 · 自愿支持. 不构成投资 / 不承诺现金回报 / 不参与分红.
      </div>

      <Hairline />

      <FieldLabel>金额自定 · ¥{MIN_DONATION_CNY} 起</FieldLabel>
      <div style={{
        display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 14,
      }}>
        <span style={{
          fontFamily: '"Noto Serif SC", serif', fontSize: 28,
          color: 'var(--ink-1, #2c2620)',
        }}>¥</span>
        <input
          type="number"
          inputMode="decimal"
          min={MIN_DONATION_CNY}
          step={0.1}
          value={amountStr}
          onChange={(e) => setAmountStr(e.target.value)}
          style={{
            flex: 1, minWidth: 0,
            background: 'transparent',
            border: 'none',
            borderBottom: '1px solid var(--rule-soft, #e3dccd)',
            outline: 'none',
            fontFamily: 'EB Garamond, serif',
            fontSize: 32, color: 'var(--ink-1, #2c2620)',
            padding: '4px 0',
          }}
        />
      </div>

      <div style={{
        display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 18,
      }}>
        <span style={{
          fontFamily: 'EB Garamond, serif', fontStyle: 'italic',
          fontSize: 12, color: 'var(--ink-3, #8b8275)',
          letterSpacing: '0.06em', alignSelf: 'center',
        }}>常见 ·</span>
        {SUGGESTION_PILLS.map((v) => {
          const active = amount === v;
          return (
            <button
              key={v}
              type="button"
              onClick={() => setAmountStr(String(v))}
              style={{
                padding: '4px 14px',
                fontFamily: 'EB Garamond, serif', fontStyle: 'italic', fontSize: 13,
                background: active ? 'var(--paper-warm, #f5efde)' : 'transparent',
                color: active ? 'var(--accent-brass, #b08a3e)' : 'var(--ink-2, #5a5246)',
                border: '1px solid ' + (active ? 'var(--accent-brass, #b08a3e)' : 'var(--rule-soft, #e3dccd)'),
                borderRadius: 999, cursor: 'pointer',
              }}
            >¥{v}</button>
          );
        })}
      </div>

      {/* 当前金额对应的回馈预览 (perks gated by amount threshold). 无门槛即「一声谢」, 无 perks 但仍记录. */}
      {Number.isFinite(amount) && amount >= MIN_DONATION_CNY && (
        <div style={{
          padding: '12px 16px',
          background: 'var(--paper, #faf6e8)',
          border: '1px solid var(--rule-soft, #e3dccd)',
          borderRadius: 2, marginBottom: 14,
        }}>
          <div style={{
            fontFamily: 'EB Garamond, serif', fontStyle: 'italic',
            fontSize: 13, color: 'var(--ink-3, #8b8275)', marginBottom: 6,
          }}>
            ¥{amount} · {matched ? matched.display_zh : '记录在册'}
          </div>
          {matched && matched.perks && matched.perks.length > 0 ? (
            <ul style={{
              listStyle: 'none', padding: 0, margin: 0,
              fontFamily: '"Noto Serif SC", serif',
              fontSize: 13, lineHeight: 1.7, color: 'var(--ink-2, #5a5246)',
            }}>
              {matched.perks.map((p, i) => (
                <li key={i} style={{ marginBottom: 2 }}>· {p}</li>
              ))}
            </ul>
          ) : (
            <div style={{
              fontFamily: '"Noto Serif SC", serif', fontSize: 13,
              color: 'var(--ink-2, #5a5246)', fontStyle: 'italic',
            }}>
              · 这一份心意我们收下, 不附额外回馈.
            </div>
          )}
        </div>
      )}

      {error && (
        <div style={{ color: 'var(--accent-terracotta, #c25a36)', fontSize: 13, marginTop: 4 }}>
          {error}
        </div>
      )}

      <div style={{ marginTop: 18, display: 'flex', alignItems: 'center', gap: 12 }}>
        <button
          onClick={onRecord}
          disabled={busy || !Number.isFinite(amount) || amount < MIN_DONATION_CNY}
          style={{
            padding: '8px 22px',
            fontFamily: 'EB Garamond, serif', fontStyle: 'italic', fontSize: 15,
            background: 'var(--accent-brass, #b08a3e)', color: 'var(--paper, #faf6e8)',
            border: 'none', borderRadius: 2,
            cursor: busy ? 'wait' : (Number.isFinite(amount) && amount >= MIN_DONATION_CNY ? 'pointer' : 'not-allowed'),
            opacity: (busy || !Number.isFinite(amount) || amount < MIN_DONATION_CNY) ? 0.6 : 1,
          }}
        >{busy ? '记录中…' : '记录此意向'}</button>
        <span style={{ fontSize: 12, color: 'var(--ink-3, #8b8275)', fontStyle: 'italic' }}>
          支付通道接入后, 此意向会自动转为 payment confirm。
        </span>
      </div>

      {recorded && (
        <div style={{
          marginTop: 14, padding: '10px 14px',
          background: 'var(--paper-warm, #f5efde)',
          border: '1px solid var(--rule-soft, #e3dccd)',
          borderRadius: 2, fontSize: 13, color: 'var(--ink-2, #5a5246)',
        }}>
          已记录 · {recorded.tier_display_zh} · ¥{recorded.amount_cny} · status: {recorded.status}
        </div>
      )}

      <Hairline />

      <div style={{
        padding: '14px 16px',
        background: 'var(--paper-warm, #f5efde)',
        border: '1px solid var(--rule-soft, #e3dccd)',
        borderRadius: 2, fontSize: 13, color: 'var(--ink-2, #5a5246)',
        whiteSpace: 'pre-wrap', lineHeight: 1.7,
      }}>
        {legal}
      </div>

      <Hairline />

      <div style={{ fontFamily: 'EB Garamond, serif', fontStyle: 'italic', fontSize: 20, marginBottom: 10 }}>
        我的支持记录
      </div>
      {my.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--ink-3, #8b8275)', fontStyle: 'italic' }}>
          还没有记录 — 选择上方任意一档并点击「记录此意向」可创建一条。
        </div>
      ) : (
        <div>
          {my.map((m) => (
            <div key={m.id} style={{
              padding: '10px 12px', marginBottom: 8,
              background: 'var(--paper, #faf6e8)',
              border: '1px solid var(--rule-soft, #e3dccd)', borderRadius: 2,
              display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
            }}>
              <div>
                <div style={{ fontFamily: 'EB Garamond, serif', fontStyle: 'italic', fontSize: 13, color: 'var(--ink-3, #8b8275)' }}>
                  {m.tier} · {new Date(m.ts_created).toLocaleString()}
                </div>
                <div style={{ fontSize: 14, marginTop: 4 }}>
                  {m.tier_display_zh} · ¥{m.amount_cny} · {m.status}
                </div>
              </div>
              <div style={{ fontSize: 12, color: 'var(--ink-3, #8b8275)', fontStyle: 'italic' }}>
                {m.id}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

window.DonateScreen = DonateScreen;
window.HYPHA_ROUTES = window.HYPHA_ROUTES || {};
window.HYPHA_ROUTES['donate'] = DonateScreen;
