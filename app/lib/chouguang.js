'use strict';

// chouguang.js — HOU-GUANG (waiting light) ambient motion grammar.
//
// 5 atomic primitives + 1 singleton coordinator implementing the LUNG council
// 2026-05-02 grammar. The room must read as a candle-lit ledger, not a printed
// table — every always-on element gets a desynced sine cycle, state-promotion
// spawns rice-paper ink-bleeds, and reserved ceremonies (theme switch, chain
// blueprint accept) suspend the ambient layer for the duration of the moment
// plus a one-second grace.
//
// API contract (consumed by VaultTree, TabContent, NoteView, App):
//   breathe(element, opts) -> Animation         // P1 desynced opacity sine
//   inkBleed(anchor, opts)                      // P2 halo on state promotion
//   opszAttention(element, opts) -> disposer    // P3 opsz tied to viewport
//   hairline(element, opts)                     // P4 1px brass draw on entry
//   ReservationCoordinator.{acquire,release,isReserved,onRelease}  // P5
//   motionAllowed()
//   xmur3(seed)
//
// Hard rules:
//   - WAAPI only (compositor thread). No CSS @keyframes, no setInterval.
//   - cancel() not pause() on viewport exit (Animation { iterations: Infinity }
//     leaks memory if paused per SCOUT 2026-05-02).
//   - id-derived clocks (LUNG C3) — every period+phase comes from xmur3(id).
//   - prefers-reduced-motion + update:slow guarded.
//   - English comments only; no emojis; no console.log.

if (typeof window === 'undefined') {
  if (typeof module !== 'undefined' && module.exports) module.exports = {};
} else {

// ---------------------------------------------------------------------------
// Token readers
// ---------------------------------------------------------------------------
function readToken(name) {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  } catch (_) { return ''; }
}
function readTokenNum(name, fallback) {
  const v = parseFloat(readToken(name));
  return Number.isFinite(v) ? v : fallback;
}
function lerp(a, b, t) { return a + (b - a) * t; }

// ---------------------------------------------------------------------------
// motionAllowed — global gate
// ---------------------------------------------------------------------------
function motionAllowed() {
  try {
    const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const slow = window.matchMedia && window.matchMedia('(update: slow)').matches;
    return !reduced && !slow;
  } catch (_) { return true; }
}

// ---------------------------------------------------------------------------
// xmur3 — fast deterministic 32-bit string hash (canonical implementation).
// Used by P1 to derive period + phase from element identity (LUNG C3).
// ---------------------------------------------------------------------------
function xmur3(seed) {
  const s = String(seed || '');
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

// ---------------------------------------------------------------------------
// P5 ReservationCoordinator — singleton
// ---------------------------------------------------------------------------
const _reservations = new Map();   // token -> { regionEl, listeners }
let _reservationId = 0;

const ReservationCoordinator = {
  acquire(regionElement, opts) {
    const o = opts || {};
    if (!regionElement || !regionElement.setAttribute) return null;
    const token = { id: ++_reservationId, reason: o.reason || 'unspecified' };
    regionElement.setAttribute('data-chouguang-reserved', '1');
    // Cancel BREATH inside the reserved region (P1 cleanup discipline).
    try {
      const breathing = regionElement.querySelectorAll('.chouguang-breathing');
      breathing.forEach(el => {
        const anims = (typeof el.getAnimations === 'function') ? el.getAnimations() : [];
        anims.forEach(a => { if (a.id === 'chouguang-breath') a.cancel(); });
      });
    } catch (_) {}
    _reservations.set(token, { regionEl: regionElement, listeners: [] });
    return token;
  },

  release(token, gracePeriodMs) {
    const grace = Number.isFinite(gracePeriodMs) ? gracePeriodMs : 1000;
    const entry = _reservations.get(token);
    if (!entry) return;
    setTimeout(() => {
      try { entry.regionEl.removeAttribute('data-chouguang-reserved'); } catch (_) {}
      entry.listeners.forEach(cb => { try { cb(); } catch (_) {} });
      _reservations.delete(token);
    }, grace);
  },

  isReserved(element) {
    if (!element) return false;
    let node = element;
    while (node && node.nodeType === 1) {
      if (node.getAttribute && node.getAttribute('data-chouguang-reserved') === '1') return true;
      node = node.parentNode;
    }
    return false;
  },

  onRelease(element, callback) {
    if (!element || typeof callback !== 'function') return;
    let node = element;
    while (node && node.nodeType === 1) {
      if (node.getAttribute && node.getAttribute('data-chouguang-reserved') === '1') {
        for (const entry of _reservations.values()) {
          if (entry.regionEl === node) { entry.listeners.push(callback); return; }
        }
      }
      node = node.parentNode;
    }
  },
};

// ---------------------------------------------------------------------------
// P1 BREATH — id-hashed opacity sine
// ---------------------------------------------------------------------------
function breathe(element, opts) {
  if (!element || !motionAllowed()) return null;
  if (typeof element.animate !== 'function') return null;
  const o = opts || {};
  if (typeof o.id !== 'string' || !o.id.length) {
    throw new Error('chouguang.breathe requires opts.id (string) for id-derived clock');
  }

  const hash = xmur3(o.id);
  const periodMin = readTokenNum('--breath-period-min-ms', 6400);
  const periodMax = readTokenNum('--breath-period-max-ms', 9200);
  const periodMs = (typeof o.periodMs === 'number')
    ? o.periodMs
    : lerp(periodMin, periodMax, (hash & 0xFF) / 255);
  const phaseMs = ((hash >>> 8) & 0xFFFFFF) / 0xFFFFFF * periodMs;

  const ampRecent = readTokenNum('--breath-amplitude-recent', 0.020);
  const ampOld = readTokenNum('--breath-amplitude-old', 0.005);
  let amplitude = (typeof o.amplitude === 'number') ? o.amplitude : ampRecent;
  if (typeof o.recencyDays === 'number' && Number.isFinite(o.recencyDays)) {
    const t = 1 - 1 / (1 + Math.max(0, o.recencyDays) / 30);
    amplitude = lerp(ampRecent, ampOld, t);
  }
  if (amplitude <= 0) return null;

  // Read the rest opacity from the element so breath modulates around its
  // baseline (caller may have set patina-decayed opacity already).
  let rest = 1;
  try {
    const computed = parseFloat(getComputedStyle(element).opacity);
    if (Number.isFinite(computed)) rest = computed;
  } catch (_) {}
  const lo = Math.max(0, rest - amplitude);
  const hi = Math.min(1, rest + amplitude);

  if (typeof element.classList !== 'undefined') {
    element.classList.add('chouguang-breathing');
  }

  const anim = element.animate(
    [
      { opacity: lo, offset: 0 },
      { opacity: hi, offset: 0.5 },
      { opacity: lo, offset: 1 },
    ],
    {
      duration: periodMs,
      iterations: Infinity,
      delay: -phaseMs,
      easing: 'linear',
    }
  );
  // Tag the Animation so ReservationCoordinator can find ours specifically.
  try { anim.id = 'chouguang-breath'; } catch (_) {}
  return anim;
}

// observed() helper — wires IntersectionObserver lifecycle. Cancels (not
// pauses) on exit, re-creates on re-entry. Returns disposer.
breathe.observed = function (element, opts) {
  if (!element || !motionAllowed()) return function () {};
  let anim = null;
  let alive = true;
  const start = () => { if (alive && !anim) anim = breathe(element, opts); };
  const stop = () => { if (anim) { try { anim.cancel(); } catch (_) {} anim = null; } };

  const io = new IntersectionObserver(entries => {
    entries.forEach(e => { if (e.isIntersecting) start(); else stop(); });
  });
  io.observe(element);

  return function dispose() {
    alive = false;
    try { io.disconnect(); } catch (_) {}
    stop();
  };
};

// ---------------------------------------------------------------------------
// P2 INK-BLEED — halo on state promotion (queued per anchor)
// ---------------------------------------------------------------------------
const _bleedLastFireAt = new WeakMap();   // anchor -> timestamp
const QUEUE_GAP_MS = 600;

function inkBleed(anchor, opts) {
  if (!anchor || !motionAllowed()) return;
  if (ReservationCoordinator.isReserved(anchor)) return;
  if (!anchor.getBoundingClientRect) return;
  const o = opts || {};

  // Per-anchor queue: same anchor cannot bleed twice within QUEUE_GAP_MS.
  const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  const lastFireAt = _bleedLastFireAt.get(anchor) || 0;
  if (now - lastFireAt < QUEUE_GAP_MS) {
    setTimeout(() => inkBleed(anchor, opts), QUEUE_GAP_MS - (now - lastFireAt));
    return;
  }
  _bleedLastFireAt.set(anchor, now);

  const scaleKey = (o.scale === 'ambient' || o.scale === 'hero') ? o.scale : 'standard';
  const scaleAmbient = readTokenNum('--ink-bleed-scale-ambient', 0.5);
  const scaleHero = readTokenNum('--ink-bleed-scale-hero', 1.5);
  const scaleFactor = (scaleKey === 'ambient') ? scaleAmbient : (scaleKey === 'hero' ? scaleHero : 1.0);

  const radiusBase = readTokenNum('--ink-bleed-radius-px', 6);
  const radius = radiusBase * scaleFactor;
  const baseDuration = readTokenNum('--ink-bleed-duration-ms', 1400);
  const duration = (typeof o.durationMs === 'number') ? o.durationMs
                 : (scaleKey === 'hero' ? baseDuration * 1.5 : baseDuration);

  // Position the bleed sibling at the anchor's center within the nearest
  // positioned ancestor (or document body as final fallback).
  const bbox = anchor.getBoundingClientRect();
  const cx = bbox.left + bbox.width / 2;
  const cy = bbox.top + bbox.height / 2;

  let host = anchor.parentElement || document.body;
  // Walk up to find a positioned ancestor; if none, append to body and use
  // page-relative coords.
  let positionedHost = host;
  while (positionedHost && positionedHost !== document.body) {
    const pos = getComputedStyle(positionedHost).position;
    if (pos === 'relative' || pos === 'absolute' || pos === 'fixed' || pos === 'sticky') break;
    positionedHost = positionedHost.parentElement;
  }
  if (!positionedHost) positionedHost = document.body;

  const hostBox = positionedHost.getBoundingClientRect();
  const localX = cx - hostBox.left;
  const localY = cy - hostBox.top;

  const bleed = document.createElement('div');
  bleed.className = 'chouguang-bleed';
  bleed.style.left = localX + 'px';
  bleed.style.top = localY + 'px';
  if (o.color) bleed.style.background = o.color;
  positionedHost.appendChild(bleed);

  const easing = readToken('--ease-cure') || 'ease-out';
  const finalScale = Math.max(2, radius);

  // v0.8.3 — dropped filter:blur from keyframes per LUNG free-insight: animated
  // blur radius (0 -> 1.4px) defeats Chromium D3D11 shader cache on Windows
  // (every interpolated frame is a fresh radius, recompiles shader). macOS
  // Metal handles this fine; Hypha runs Windows; user reported lag. Now
  // transform + opacity only — both pure compositor properties.
  const anim = bleed.animate(
    [
      { transform: 'translate(-50%, -50%) scale(1)', opacity: 0.42 },
      { transform: `translate(-50%, -50%) scale(${finalScale})`, opacity: 0 },
    ],
    { duration: duration, easing: easing, fill: 'forwards' }
  );
  anim.finished.finally(() => { try { bleed.remove(); } catch (_) {} });
}

// ---------------------------------------------------------------------------
// P3 OPSZ-TIED-TO-ATTENTION — variable font opsz axis on display type only
// ---------------------------------------------------------------------------
function opszAttention(element, opts) {
  if (!element) return function () {};
  if ((element.textContent || '').length > 150) {
    // Safety guard per SCOUT 2026-05-02: opsz on body text triggers full
    // relayout. Caller must restrict to display type.
    throw new Error('chouguang.opszAttention refuses textContent > 150 chars (relayout cost)');
  }
  if (!motionAllowed()) return function () {};

  const o = opts || {};
  const restMin = (typeof o.restMin === 'number') ? o.restMin : readTokenNum('--opsz-rest', 12);
  const focusMax = (typeof o.focusMax === 'number') ? o.focusMax : readTokenNum('--opsz-focus', 18);

  let currentOpsz = restMin;
  let pending = null;

  const apply = (target) => {
    if (Math.abs(target - currentOpsz) < 0.05) return;
    if (pending) cancelAnimationFrame(pending);
    pending = requestAnimationFrame(() => {
      pending = null;
      const anim = element.animate(
        [
          { fontVariationSettings: '"opsz" ' + currentOpsz },
          { fontVariationSettings: '"opsz" ' + target },
        ],
        { duration: 200, fill: 'forwards', easing: 'linear' }
      );
      currentOpsz = target;
      try { anim.id = 'chouguang-opsz'; } catch (_) {}
    });
  };

  const io = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (!e.isIntersecting) { apply(restMin); return; }
      const vh = window.innerHeight || document.documentElement.clientHeight;
      const r = e.intersectionRect || e.boundingClientRect;
      const inMiddle = (r.top > vh * 0.33) && (r.bottom < vh * 0.66);
      apply(inMiddle ? focusMax : restMin);
    });
  }, { threshold: [0, 0.33, 0.66, 1] });
  io.observe(element);

  return function dispose() {
    try { io.disconnect(); } catch (_) {}
    if (pending) cancelAnimationFrame(pending);
    try { element.style.fontVariationSettings = ''; } catch (_) {}
  };
}

// ---------------------------------------------------------------------------
// P4 HAIRLINE — 1px brass line draws L-to-R on first viewport entry.
// CSS provides .chouguang-hl ::after with clip-path transition; we just flip
// data-hl-drawn="1" once, the CSS animation handles the draw.
// ---------------------------------------------------------------------------
function hairline(element, opts) {
  if (!element || !motionAllowed()) return;
  const o = opts || {};
  if (element.dataset && element.dataset.hlDrawn === '1') return;
  if (!element.classList.contains('chouguang-hl')) {
    element.classList.add('chouguang-hl');
  }

  const draw = () => {
    if (!element || !element.dataset) return;
    if (element.dataset.hlDrawn === '1') return;
    if (o.defer && ReservationCoordinator.isReserved(element)) {
      ReservationCoordinator.onRelease(element, () => { try { element.dataset.hlDrawn = '1'; } catch (_) {} });
      return;
    }
    // CSS handles the draw via the transition declared in colors_and_type.css
    // (.chouguang-hl::after has clip-path transition with --ease-cure timing).
    // Duration override via inline style if caller asked for non-default.
    if (typeof o.durationMs === 'number') {
      try { element.style.setProperty('--hairline-draw-duration-ms', o.durationMs + 'ms'); } catch (_) {}
    }
    try { element.dataset.hlDrawn = '1'; } catch (_) {}
  };

  const onlyFirst = (o.onlyFirstEntry !== false);   // default true
  const io = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (e.isIntersecting) {
        draw();
        if (onlyFirst) try { io.disconnect(); } catch (_) {}
      }
    });
  }, { threshold: 0.1 });
  io.observe(element);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
const api = {
  motionAllowed,
  xmur3,
  breathe,
  inkBleed,
  opszAttention,
  hairline,
  ReservationCoordinator,
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
window.chouguang = api;

}  // end of `if (typeof window !== 'undefined')`
