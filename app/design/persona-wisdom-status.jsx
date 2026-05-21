/* global React */
//
// HYPHA · Persona Wisdom Status (γ10 Persona Wisdom surface, 2026-05-15)
//
// Mounts as a 9px dot in the lesson header band next to Provider Health.
// Honest signal — tells the user whether the persona this lesson is using
// is backed by a distilled corpus, a hand-drafted wisdom file, or just a
// string-register fallback. Same visual rhythm as HealthBadge.
//
// Resolution priority:
//   1. If parent passes personaId, call window.ptor.hypha.personaGetWisdom
//      directly + read `status` from the result.
//   2. Else derive personaId from vault/<slug>/agent.json via
//      window.ptor.hypha.agentGet(slug) → profile.persona, then probe.
//
// Status semantics (canonical from agent.js γ10):
//   DISTILLED              — brass dot, real distilled corpus present
//   DISTILLED_HUMAN_DRAFT  — deep-brown dot, human-curated wisdom file
//   WAITING_DISTILL        — tabac dot, fallback to string register
//   anything else / null   — tabac dot, treat as WAITING

const STATUS_DOT = {
  DISTILLED:              { color: 'var(--brass-bright, #b8893a)', tip: 'Persona 蒸馏 corpus 已注入' },
  DISTILLED_HUMAN_DRAFT:  { color: '#6B4A2B',                       tip: 'Persona 用人工 draft wisdom' },
  WAITING_DISTILL:        { color: '#8A7F6E',                       tip: 'Persona 用 string register fallback · 真 wisdom 待蒸馏' },
};

const _baseFont = '"EB Garamond", "Noto Serif SC", serif';

// Normalize the wisdom-status response into one of the three known states.
// Defensive: accepts either {status} or {wisdom_status} (events.jsonl flavor)
// AND treats absent file / null result as WAITING_DISTILL — the most
// conservative read so we never falsely advertise distilled provenance.
function _normalizeStatus(payload) {
  if (!payload || typeof payload !== 'object') return 'WAITING_DISTILL';
  const raw = payload.status || payload.wisdom_status || (payload.wisdom && payload.wisdom.status);
  if (typeof raw !== 'string') return 'WAITING_DISTILL';
  const upper = raw.trim().toUpperCase();
  if (upper === 'DISTILLED') return 'DISTILLED';
  if (upper === 'DISTILLED_HUMAN_DRAFT') return 'DISTILLED_HUMAN_DRAFT';
  if (upper === 'WAITING_DISTILL' || upper === 'WAITING') return 'WAITING_DISTILL';
  return 'WAITING_DISTILL';
}

const PersonaWisdomStatus = ({ slug, lessonIdx: _lessonIdx, personaId }) => {
  const { useState, useEffect } = React;
  const [status, setStatus] = useState(null);
  const [resolvedPersona, setResolvedPersona] = useState(personaId || null);

  // Persona resolution — if parent did not pass one, fall back to agent.json
  // for the current slug. Runs once per (slug, personaId) change.
  useEffect(() => {
    if (personaId) { setResolvedPersona(personaId); return undefined; }
    if (!slug) { setResolvedPersona(null); return undefined; }
    let alive = true;
    (async () => {
      try {
        const hypha = window.ptor && window.ptor.hypha;
        if (!hypha || typeof hypha.agentGet !== 'function') return;
        const r = await hypha.agentGet(slug);
        if (!alive) return;
        const pid = (r && r.profile && r.profile.persona) ||
                    (r && r.persona) || null;
        if (pid) setResolvedPersona(pid);
      } catch (_) { /* leave null — dot stays hidden */ }
    })();
    return () => { alive = false; };
  }, [slug, personaId]);

  // Wisdom probe — once resolvedPersona is known, ask the bridge for its
  // current status. Silent on any failure (dot stays hidden rather than
  // surfacing a misleading state).
  useEffect(() => {
    if (!resolvedPersona) { setStatus(null); return undefined; }
    let alive = true;
    (async () => {
      try {
        const hypha = window.ptor && window.ptor.hypha;
        if (!hypha || typeof hypha.personaGetWisdom !== 'function') {
          if (alive) setStatus('WAITING_DISTILL');
          return;
        }
        const r = await hypha.personaGetWisdom(resolvedPersona);
        if (!alive) return;
        setStatus(_normalizeStatus(r && r.ok ? (r.result || r) : r));
      } catch (_) {
        if (alive) setStatus('WAITING_DISTILL');
      }
    })();
    return () => { alive = false; };
  }, [resolvedPersona]);

  if (!resolvedPersona || !status) return null;
  const tone = STATUS_DOT[status] || STATUS_DOT.WAITING_DISTILL;
  const tipFull = `${tone.tip}${resolvedPersona ? ' · ' + resolvedPersona : ''}`;
  return (
    <div
      className="persona-wisdom-status"
      style={{
        position: 'relative',
        marginRight: 14,
        lineHeight: 0,
        cursor: 'default',
      }}
      title={tipFull}
      aria-label={tipFull}
    >
      <div style={{
        width: 9,
        height: 9,
        borderRadius: '50%',
        background: tone.color,
        boxShadow: '0 0 0 1.5px rgba(255,255,255,.7)',
      }} />
      <div style={{
        position: 'absolute',
        top: 11,
        left: '50%',
        transform: 'translateX(-50%)',
        fontFamily: _baseFont,
        fontStyle: 'italic',
        fontSize: 8,
        color: 'var(--ink-3, #7a5e54)',
        letterSpacing: '0.04em',
        whiteSpace: 'nowrap',
        pointerEvents: 'none',
        opacity: 0,
      }}>
        {/* hidden caption slot — present for future Provider-Health-style
            popover expansion, kept inert today to honor the small-dot register */}
      </div>
    </div>
  );
};

if (typeof window !== 'undefined') {
  window.PersonaWisdomStatus = PersonaWisdomStatus;
}
