// Ported from ptor/vc/harness/renderer.js (signed v0.1).
// Diffs vs. harness:
//   - Canvas mounts inside #terminal-container (not full viewport).
//   - Dimensions read from container.clientWidth/clientHeight, not window.
//   - ResizeObserver watches #terminal-container (container can resize without window resize).
// Everything else — font metrics, grid_diff application, cursor draw, keydown/paste dispatch,
// vc-core message handling — verbatim from harness.
//
// Invariants honored:
//   9a — await document.fonts.ready before first paint
//   9b — Canvas only, no DOM per-cell
//   9c — ResizeObserver reads geometry; writes go through rAF-gated path
//   9e — repaint ceiling 60Hz (rAF-coalesced)
//   9g — overlays (none here) would be composited; canvas alone is fine

'use strict';

// PTOR-design wrapper: production renderer was top-level script. Here we wrap
// in a function so React/LiveTerminal can call it AFTER mounting the required
// DOM (#terminal-container, #term, #term-input, #term-composition,
// #term-selection-layer). Idempotent — calling twice is a no-op.
function startVcRenderer() {
  if (startVcRenderer.__started) return;
  startVcRenderer.__started = true;

const container = document.getElementById('terminal-container');
const canvas = document.getElementById('term');
const ctx = canvas.getContext('2d', { alpha: false });
// IME focus sink (v0.3 roadmap #1). Canvas !receive compositionstart/update/end
// from the browser — those events route to whatever element owns composition
// (contenteditable or textarea). We mount a transparent textarea over the
// terminal surface and funnel all keyboard/composition/paste events through
// it. Canvas stays render-only.
const inputEl = document.getElementById('term-input');
const compositionEl = document.getElementById('term-composition');
const selectionLayer = document.getElementById('term-selection-layer');
// Composition state (Invariant 1 atomic chain): while true, keydown is
// swallowed — IME is assembling a composed sequence. On compositionend the
// final text ships as a single {type:"paste"} bracketed send.
let isComposing = false;

const FONT_SIZE = 14;
const FONT_FAMILY = '"Cascadia Code", "Cascadia Mono", Consolas, "Courier New", monospace';
const BG = '#1a1a1a';
const FG = '#e0e0e0';
const CURSOR = '#7ed3ff';

let cellW = 0;
let cellH = 0;
let cols = 0;
let rows = 0;
let dpr = window.devicePixelRatio || 1;

let grid = [];
let cur = { x: 0, y: 0, visible: true };
let altScreen = false;

// v0.4 #1 selection state — declared early because resizeCanvasToContainer()
// reads `selection` (to re-anchor or clear on resize) and runs at boot before
// the selection-helpers section further down. Without these hoisted decls the
// `let` binding stays in TDZ during boot and resizeCanvasToContainer throws
// "Cannot access 'selection' before initialization".
let selection = null;
let selectionDragging = false;
let selectionAnchor = null;

let resizePending = false;
let lastSentResize = { cols: 0, rows: 0 };

// Roadmap #2: mouse-mode state mirrored from CoreMsg::MouseMode. Gates the
// mousedown/up/move/wheel forwarding. Renderer never second-guesses — if the
// app hasn't enabled any mouse mode, clicks/motion are no-ops and the wheel
// falls back to existing behavior (#3/#5 scroll-lock + coalescer).
//   sgr    — xterm SGR extended mouse coords enabled (\x1b[?1006h)
//   button — press/release/drag tracking enabled (\x1b[?1000h / ?1002h)
//   motion — all-motion tracking enabled (\x1b[?1003h)
// `any` is true if ANY of the three is set — used by gates everywhere.
let mouseMode = { sgr: false, button: false, motion: false };
const anyMouseMode = () => mouseMode.sgr || mouseMode.button || mouseMode.motion;
// Tracks which buttons are currently held, for drag encoding. 0=left, 1=middle,
// 2=right. When a button is held and mousemove fires, we emit a drag report
// (button + bit 32) instead of the all-motion "no button" variant (button 3).
const heldButtons = new Set();

// ----- font metrics -----
// Wide-char horizontal scale. Roadmap v0.3 #1 Invariant 7: grid rigidity.
// Most CJK glyphs in monospace fonts render at ~2× the ASCII cell width,
// matching alacritty's WIDE_CHAR flag semantics. If the font disagrees
// (ASCII-only font falling back to CJK via browser, or user's monospace
// happens to have oversized CJK), scale the glyph X to preserve grid rigidity.
let wideCharScaleX = 1;

function measureCell() {
  ctx.font = `${FONT_SIZE}px ${FONT_FAMILY}`;
  ctx.textBaseline = 'top';
  const m = ctx.measureText('M');
  cellW = Math.max(1, Math.round(m.width));
  cellH = Math.max(1, Math.round(FONT_SIZE * 1.35));
  // Wide-cell probe: '测' is a standard CJK glyph; expect ~2× ASCII width.
  const mw = ctx.measureText('测');
  const target = cellW * 2;
  if (mw.width > 0 && Math.abs(mw.width - target) / target > 0.05) {
    wideCharScaleX = target / mw.width;
  } else {
    wideCharScaleX = 1;
  }
}

// ----- canvas sizing -----
function resizeCanvasToContainer() {
  const cssW = container.clientWidth;
  const cssH = container.clientHeight;
  if (cssW < 10 || cssH < 10) return;  // container collapsed; wait for layout
  if (cellW < 1 || cellH < 1) return;  // font metrics not yet measured — ResizeObserver may fire before boot's measureCell
  dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  canvas.style.width = cssW + 'px';
  canvas.style.height = cssH + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // MEOW audit 2026-04-24 #4: recompute cellW/cellH + wideCharScaleX on every
  // resize — catches dpr change (move window between screens) + any future
  // runtime font swap. Must be BEFORE cols/rows computation (uses cellW).
  measureCell();
  ctx.textBaseline = 'top';
  const newCols = Math.max(10, Math.floor(cssW / cellW));
  const newRows = Math.max(3, Math.floor(cssH / cellH));
  if (newCols !== cols || newRows !== rows) {
    cols = newCols;
    rows = newRows;
    resizeGridBuffer();
  }
  paintAll();
  maybeSendResize();
  // Recompute thumb geometry on container resize; the track is pinned to
  // container edges via absolute positioning so the CSS layer is fine.
  updateScrollbar();
  // v0.4 #1: re-anchor selection rects to new cell metrics. If selection now
  // sits outside the resized grid, clamp by clearing — content under it has
  // shifted, the visual selection no longer matches what user picked.
  if (selection) {
    if (selection.endRow >= rows || selection.startRow >= rows
        || selection.endCol >= cols || selection.startCol >= cols) {
      clearSelection();
    } else {
      renderSelectionOverlay();
    }
  }
}

function resizeGridBuffer() {
  const next = [];
  for (let y = 0; y < rows; y++) {
    const oldRow = grid[y];
    const row = [];
    for (let x = 0; x < cols; x++) {
      row.push(oldRow && oldRow[x] ? oldRow[x] : blankCell());
    }
    next.push(row);
  }
  grid = next;
}

function blankCell() {
  return { ch: ' ', wide: 1, bold: false, italic: false, underline: false };
}

let bootRedrawSent = false;

function maybeSendResize() {
  if (cols < 10 || rows < 3) return;
  if (cols === lastSentResize.cols && rows === lastSentResize.rows) return;
  const firstValid = lastSentResize.cols === 0 && lastSentResize.rows === 0;
  lastSentResize = { cols, rows };
  window.vc.send({ type: 'resize', cols, rows });
  // After the very first valid resize, ask core to re-emit the viewport.
  // On hard reload (Ctrl+R page refresh, dev reload) our local grid is blank
  // but the PTY + alacritty state survived — without this, the canvas stays
  // blank until the shell writes something new.
  if (firstValid && !bootRedrawSent) {
    bootRedrawSent = true;
    window.vc.send({ type: 'redraw' });
  }
}

// ----- full paint (on resize / init) -----
function paintAll() {
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, canvas.width / dpr, canvas.height / dpr);
  ctx.fillStyle = FG;
  for (let y = 0; y < rows; y++) {
    drawRowRange(y, 0, cols - 1);
  }
  drawCursor();
}

// ----- cell-range paint (for grid_diff) -----
function drawRowRange(y, left, right) {
  if (y < 0 || y >= rows) return;
  const px = left * cellW;
  const py = y * cellH;
  const w = (right - left + 1) * cellW;
  ctx.fillStyle = BG;
  ctx.fillRect(px, py, w, cellH);
  for (let x = left; x <= right; x++) {
    const cell = grid[y] && grid[y][x];
    if (!cell) continue;
    drawCell(x, y, cell);
  }
}

function drawCell(x, y, cell) {
  if (!cell || !cell.ch || cell.ch === ' ') return;
  let font = `${FONT_SIZE}px ${FONT_FAMILY}`;
  if (cell.bold && cell.italic) font = `bold italic ${font}`;
  else if (cell.bold) font = `bold ${font}`;
  else if (cell.italic) font = `italic ${font}`;
  ctx.font = font;
  ctx.fillStyle = FG;
  const wide = cell.wide === 2;
  if (wide && wideCharScaleX !== 1) {
    // Glyph metric disagrees with 2× cellW — scale to fit. Preserve grid
    // rigidity (Invariant 7) even at cost of glyph distortion.
    ctx.save();
    ctx.translate(x * cellW, y * cellH);
    ctx.scale(wideCharScaleX, 1);
    ctx.fillText(cell.ch, 0, 0);
    ctx.restore();
  } else {
    ctx.fillText(cell.ch, x * cellW, y * cellH);
  }
  if (cell.underline) {
    const uy = y * cellH + cellH - 2;
    ctx.fillRect(x * cellW, uy, cellW * (wide ? 2 : 1), 1);
  }
}

function drawCursor() {
  if (!cur.visible) return;
  if (cur.y < 0 || cur.y >= rows || cur.x < 0 || cur.x >= cols) return;
  const px = cur.x * cellW;
  const py = cur.y * cellH;
  ctx.fillStyle = CURSOR;
  ctx.globalAlpha = 0.45;
  ctx.fillRect(px, py, cellW, cellH);
  ctx.globalAlpha = 1;
  const cell = grid[cur.y] && grid[cur.y][cur.x];
  if (cell) drawCell(cur.x, cur.y, cell);
}

// ----- grid_diff application (rAF-coalesced) -----
const pendingDiffs = [];
let rafScheduled = false;

function applyDiff(diffMsg) {
  pendingDiffs.push(diffMsg);
  if (!rafScheduled) {
    rafScheduled = true;
    requestAnimationFrame(flushDiffs);
  }
}

function flushDiffs() {
  rafScheduled = false;
  const prevCur = { ...cur };
  if (prevCur.visible) {
    drawRowRange(prevCur.y, prevCur.x, prevCur.x);
  }
  while (pendingDiffs.length) {
    const diff = pendingDiffs.shift();
    if (!diff.damage) continue;
    for (const line of diff.damage) {
      const y = line.y;
      if (y < 0 || y >= rows) continue;
      if (!line.cells.length) continue;
      let minX = cols, maxX = -1;
      // Build set of x positions present in this batch — so spacer-clear
      // for wide cells doesn't clobber a legitimate x+1 write in the SAME
      // batch (MEOW audit #3 defensive: core shouldn't emit x+1 when wide
      // at x, but the invariant lives in core, not the wire).
      const wroteX = new Set();
      for (const c of line.cells) wroteX.add(c.x);
      for (const cell of line.cells) {
        if (cell.x < 0 || cell.x >= cols) continue;
        grid[y][cell.x] = {
          ch: cell.ch || ' ',
          wide: cell.wide || 1,
          bold: !!cell.bold,
          italic: !!cell.italic,
          underline: !!cell.underline,
        };
        if (cell.x < minX) minX = cell.x;
        if (cell.x > maxX) maxX = cell.x;
        // Wide-char spacer clear. Core emits wide=2 but SKIPS the spacer cell
        // (main.rs:537). Renderer's grid[y][x+1] keeps stale content → draws
        // over the wide glyph's right half. Clear only if x+1 is NOT also
        // written in this batch (defensive — protects against core regression).
        if (cell.wide === 2 && cell.x + 1 < cols && !wroteX.has(cell.x + 1)) {
          grid[y][cell.x + 1] = { ch: ' ', wide: 1, bold: false, italic: false, underline: false };
          if (cell.x + 1 > maxX) maxX = cell.x + 1;
        }
      }
      if (maxX >= minX) drawRowRange(y, minX, maxX);
    }
  }
  drawCursor();
}

// ----- viewport lock / "new output" pill (roadmap #3 + #6) -----
// Renderer-owned flag: true once the user has scrolled up and wants the viewport
// to hold while new PTY output arrives. Cleared on explicit scroll-to-bottom,
// Ctrl+End, or auto-clear when the core-reported offset falls within
// NEAR_BOTTOM_LINES of the bottom. Communicated to core via
// {type:"viewport_lock", locked}. Core then suppresses the implicit auto-snap
// during PtyBytes parsing.
let viewportLocked = false;
const NEAR_BOTTOM_LINES = 2;
// Authoritative viewport state from core (roadmap #6). Replaced the pessimistic
// estScrollOffset accumulator that used to live here — core now knows the exact
// display_offset + history_size, so the renderer no longer guesses. Every
// CoreMsg::Viewport update refreshes these; scrollbar + auto-unlock both read
// from here.
let vpOffset = 0;   // lines scrolled up from bottom (0 = at bottom)
let vpTotal = 0;    // total history lines available (scrollback depth)

function setViewportLocked(next) {
  if (next === viewportLocked) return;
  viewportLocked = next;
  window.vc.send({ type: 'viewport_lock', locked: next });
  if (!next) hideNewOutputPill();
}

// "↓ new output" pill: appears when locked AND new grid_diff lands; fades out
// on unlock or on reaching bottom. Uses the same absolute-positioned + CSS-fade
// pattern as vc-warn-banner, different class.
let newOutputPillEl = null;
let newOutputPillVisible = false;

function getNewOutputPill() {
  if (newOutputPillEl) return newOutputPillEl;
  const el = document.createElement('div');
  el.className = 'vc-new-output-pill';
  Object.assign(el.style, {
    position: 'absolute',
    left: '50%',
    bottom: '10px',
    transform: 'translateX(-50%)',
    padding: '4px 12px',
    background: 'rgba(126, 211, 255, 0.18)',
    border: '1px solid rgba(126, 211, 255, 0.55)',
    color: '#cfefff',
    fontFamily: 'var(--font-mono, monospace)',
    fontSize: '11px',
    letterSpacing: '0.3px',
    borderRadius: '10px',
    pointerEvents: 'none',
    zIndex: '55',
    opacity: '0',
    transition: 'opacity 180ms ease',
    userSelect: 'none',
  });
  el.textContent = '↓ new output';
  (container || document.body).appendChild(el);
  newOutputPillEl = el;
  return el;
}

function showNewOutputPill() {
  if (!viewportLocked) return;
  const el = getNewOutputPill();
  if (!newOutputPillVisible) {
    el.style.opacity = '1';
    newOutputPillVisible = true;
  }
}

function hideNewOutputPill() {
  if (!newOutputPillEl || !newOutputPillVisible) return;
  newOutputPillEl.style.opacity = '0';
  newOutputPillVisible = false;
}

// ----- scrollbar affordance (roadmap #6) -----
// Thin (6px) composited overlay on right edge of #terminal-container. Track is
// a dim background, thumb an accent rect. Position + size computed from the
// core-authoritative {offset, total} + local `rows`. Auto-hide 1.5s after the
// last scroll. Display only — no drag, no click-to-jump (v0.3 scope, spec
// defers interactivity to v0.4 drawer work).
const SCROLLBAR_WIDTH = 6;
const SCROLLBAR_MIN_THUMB = 20;
const SCROLLBAR_HIDE_MS = 1500;
let scrollbarTrackEl = null;
let scrollbarThumbEl = null;
let scrollbarHideTimer = null;

function getScrollbarEls() {
  if (scrollbarTrackEl && scrollbarThumbEl) {
    return { track: scrollbarTrackEl, thumb: scrollbarThumbEl };
  }
  const track = document.createElement('div');
  track.className = 'vc-scrollbar';
  Object.assign(track.style, {
    position: 'absolute',
    top: '0',
    right: '0',
    bottom: '0',
    width: SCROLLBAR_WIDTH + 'px',
    background: 'rgba(255, 255, 255, 0.04)',
    pointerEvents: 'none',
    zIndex: '54',
    opacity: '0',
    transition: 'opacity 200ms ease',
  });
  const thumb = document.createElement('div');
  thumb.className = 'vc-scrollbar-thumb';
  Object.assign(thumb.style, {
    position: 'absolute',
    left: '0',
    right: '0',
    background: 'rgba(126, 211, 255, 0.55)',
    borderRadius: '3px',
    // Interactivity deferred per spec; keep inert.
    pointerEvents: 'none',
    top: '0px',
    height: SCROLLBAR_MIN_THUMB + 'px',
  });
  track.appendChild(thumb);
  (container || document.body).appendChild(track);
  scrollbarTrackEl = track;
  scrollbarThumbEl = thumb;
  return { track, thumb };
}

function updateScrollbar() {
  // No scrollback history or not yet sized → hide entirely.
  if (vpTotal <= 0 || rows <= 0) {
    if (scrollbarTrackEl) scrollbarTrackEl.style.opacity = '0';
    return;
  }
  const { track, thumb } = getScrollbarEls();
  const trackH = track.clientHeight || container.clientHeight || 0;
  if (trackH < SCROLLBAR_MIN_THUMB + 4) {
    track.style.opacity = '0';
    return;
  }
  // Thumb height ∝ visibleRows / (history + visibleRows). Floor at MIN so the
  // affordance stays discoverable for deep scrollback.
  const totalRows = vpTotal + rows;
  const thumbH = Math.max(
    SCROLLBAR_MIN_THUMB,
    Math.floor((rows / totalRows) * trackH),
  );
  // offset=0 → thumb at bottom; offset=vpTotal → thumb at top.
  const travel = trackH - thumbH;
  const fromTopFraction = vpTotal > 0 ? (vpTotal - vpOffset) / totalRows : 1;
  const topPx = Math.max(0, Math.min(travel, Math.round(fromTopFraction * trackH)));
  thumb.style.height = thumbH + 'px';
  thumb.style.top = topPx + 'px';
  track.style.opacity = '1';
  clearTimeout(scrollbarHideTimer);
  scrollbarHideTimer = setTimeout(() => {
    if (scrollbarTrackEl) scrollbarTrackEl.style.opacity = '0';
  }, SCROLLBAR_HIDE_MS);
}

// ----- warn banner (vc-core → UI non-fatal warnings) -----
// Debounce: at most one banner per code per 5 s. Banner auto-hides after 4 s.
const WARN_DEBOUNCE_MS = 5000;
const WARN_VISIBLE_MS = 4000;
const warnLastShown = new Map(); // code → ts
let warnBannerEl = null;
let warnHideTimer = null;

function getWarnBanner() {
  if (warnBannerEl) return warnBannerEl;
  const el = document.createElement('div');
  el.className = 'vc-warn-banner';
  Object.assign(el.style, {
    position: 'absolute',
    left: '0',
    right: '0',
    bottom: '0',
    padding: '6px 12px',
    background: 'rgba(160, 40, 40, 0.92)',
    color: '#fff',
    fontFamily: 'var(--font-mono, monospace)',
    fontSize: '11.5px',
    letterSpacing: '0.2px',
    textAlign: 'center',
    pointerEvents: 'none',
    zIndex: '60',
    opacity: '0',
    transition: 'opacity 220ms ease',
  });
  (container || document.body).appendChild(el);
  warnBannerEl = el;
  return el;
}

function showWarnBanner(code, detail) {
  const now = Date.now();
  const last = warnLastShown.get(code) || 0;
  if (now - last < WARN_DEBOUNCE_MS) return;
  warnLastShown.set(code, now);
  const el = getWarnBanner();
  el.textContent = `⚠ ${code}: ${detail || ''}`.slice(0, 240);
  el.style.opacity = '1';
  clearTimeout(warnHideTimer);
  warnHideTimer = setTimeout(() => { el.style.opacity = '0'; }, WARN_VISIBLE_MS);
}

// ----- vc-core message dispatcher -----
window.vc.onMessage((msg) => {
  switch (msg.type) {
    case 'ready':
      console.log(`[vc-core] ready ${msg.version} (${msg.phase})`);
      break;
    case 'grid_diff':
      applyDiff(msg);
      // Roadmap #3: while the user holds the viewport, surface a "new output"
      // pill when fresh bytes paint. Only meaningful outside alt-screen.
      if (viewportLocked && !altScreen && msg.damage && msg.damage.length) {
        showNewOutputPill();
      }
      break;
    case 'cursor':
      cur = { x: msg.x, y: msg.y, visible: msg.visible };
      if (!rafScheduled) {
        rafScheduled = true;
        requestAnimationFrame(flushDiffs);
      }
      break;
    case 'alt_screen':
      altScreen = !!msg.active;
      break;
    case 'mouse_mode':
      // Roadmap #2: DEC-private mouse-mode flag toggle. When all three go
      // false (app issued `\x1b[?1000l` etc.) we also drop any stale held
      // buttons — the app just told us it's no longer interested, so we
      // forget the state rather than re-sending a spurious release.
      mouseMode = {
        sgr: !!msg.sgr,
        button: !!msg.button,
        motion: !!msg.motion,
      };
      if (!anyMouseMode()) {
        heldButtons.clear();
      }
      break;
    case 'title':
      document.title = msg.text ? `PTOR — ${msg.text}` : 'PTOR';
      break;
    case 'warn':
      console.error(`[vc-core:WARN] ${msg.code}: ${msg.detail || ''}`);
      showWarnBanner(msg.code, msg.detail);
      break;
    case 'viewport':
      // Roadmap #6: authoritative scroll state from core. Update scrollbar +
      // reconcile viewport lock with ground truth. If core reports we're at
      // the bottom (or within NEAR_BOTTOM_LINES), clear the lock — this
      // replaces the pessimistic estScrollOffset accumulator from #3.
      vpOffset = typeof msg.offset === 'number' ? msg.offset : 0;
      vpTotal = typeof msg.total === 'number' ? msg.total : 0;
      if (viewportLocked && vpOffset <= NEAR_BOTTOM_LINES) {
        setViewportLocked(false);
      }
      updateScrollbar();
      break;
    case 'exit':
      console.error(`[vc-core] exited code=${msg.code}`);
      // MEOW aggregate audit #2: viewport lock is sticky — if user had
      // scrolled up when the shell exited, the lock stays on forever and
      // the "new output" pill remains visible. Clear both on exit.
      if (viewportLocked) setViewportLocked(false);
      hideNewOutputPill();
      break;
  }
});

window.vc.onFatal((msg) => {
  console.error('[vc-core:FATAL]', msg);
});

// ----- input -----
// Keys that must go as {type:"key", code} — control keys the shell expects as escape sequences.
const KEY_CODES = new Set([8, 9, 13, 27, 33, 34, 35, 36, 37, 38, 39, 40, 46]);

inputEl.addEventListener('keydown', (e) => {
  // While IME composition active: suppress all keydown — composed text ships
  // atomically on compositionend. Browser's compositionstart fires BEFORE the
  // IME-committed keydown, so e.isComposing is true here during assembly.
  if (isComposing || e.isComposing) return;

  // Ctrl+Shift+R — request full redraw from core. Explicit Ctrl+Shift, NOT plain
  // Ctrl+R (bash reverse-search uses that — don't hijack).
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'r') {
    window.vc.send({ type: 'redraw' });
    e.preventDefault();
    return;
  }

  // v0.4 #1: Ctrl+Shift+K — capture selection to vault inbox/CAPTURE-{ts}.md.
  // Silent no-op when nothing selected.
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if (!hasSelection()) return;
    const text = getSelectionText();
    if (!text) return;
    if (window.ptor && window.ptor.captureTerminal) {
      window.ptor.captureTerminal({ text }).then(r => {
        if (r && r.ok) clearSelection();
      });
    }
    return;
  }

  // v0.4 #1: Esc clears active selection (else falls through to shell as ESC byte).
  if (e.key === 'Escape' && hasSelection()) {
    clearSelection();
    e.preventDefault();
    return;
  }

  // v0.4 #1: Ctrl+C with selection → copy to clipboard, do NOT send SIGINT.
  // No selection → fall through to existing Ctrl+letter path (sends \x03).
  if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey
      && e.key.toLowerCase() === 'c' && hasSelection()) {
    const text = getSelectionText();
    if (text) {
      try { navigator.clipboard.writeText(text); } catch (_) {}
    }
    clearSelection();
    e.preventDefault();
    return;
  }

  // Ctrl+V / Cmd+V / Shift+Insert — PASTE: do not intercept, do not preventDefault.
  // The separate `paste` event listener below brackets it via core. Swallowing here
  // would (a) send raw \x16 as text, and (b) in some Chromium builds suppress the
  // subsequent paste event entirely.
  const isCtrlV = (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'v';
  const isShiftInsert = e.shiftKey && e.key === 'Insert';
  if (isCtrlV || isShiftInsert) {
    return; // let browser fire the paste event
  }

  // Ctrl+C / Ctrl+D / Ctrl+Z etc. — send raw control byte as text.
  if (e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1) {
    const k = e.key.toLowerCase();
    const code = k.charCodeAt(0);
    if (code >= 97 && code <= 122) {
      window.vc.send({ type: 'text', data: String.fromCharCode(code - 96) });
      e.preventDefault();
      return;
    }
  }
  if (KEY_CODES.has(e.keyCode)) {
    window.vc.send({ type: 'key', code: e.keyCode });
    e.preventDefault();
    return;
  }
  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
    window.vc.send({ type: 'text', data: e.key });
    e.preventDefault();
  }
});

// Prevent textarea from accumulating user input as its own value — the
// terminal is the state of truth. Without this, typed chars stack up in the
// textarea and get re-read on paste etc.
//
// Also defends against IME suggestion picker / autocomplete dropdowns that
// some Chromium versions show despite autocomplete="off": when user clicks
// a suggestion, an `input` event fires with inputType="insertFromYanked" or
// similar. That text is NOT from keydown or composition, so it's not
// otherwise sent. Route it as paste (same atomic invariant as compositionend)
// so the shell at least receives it once.
inputEl.addEventListener('input', (e) => {
  if (isComposing) return;  // let composition own .value during assembly
  // Detect suggestion-picker leak: value is non-empty AND input type is not
  // one we handled in keydown (keydown handler preventDefault's + sends for
  // plain chars, so value would normally be ''). If we see content here, it
  // came from a path we didn't intercept (IME dropdown pick, voice input,
  // drag-and-drop). Ship it as paste once.
  const leaked = inputEl.value;
  if (leaked && !e.inputType?.startsWith('insertCompositionText')) {
    window.vc.send({ type: 'paste', data: leaked });
  }
  inputEl.value = '';
});

// ----- IME composition handlers (v0.3 roadmap #1) -----
// compositionstart: flag ON, show preview overlay at cursor cell.
// compositionupdate: update preview text (display only; do NOT send bytes).
// compositionend: send the final composed string as ONE {type:"paste", data}.
//   Atomic per Invariant 1. Core brackets it if bracketed-paste mode is on.
inputEl.addEventListener('compositionstart', () => {
  isComposing = true;
  inputEl.value = '';
  showCompositionPreview('');
});
inputEl.addEventListener('compositionupdate', (e) => {
  showCompositionPreview(e.data || '');
});
inputEl.addEventListener('compositionend', (e) => {
  isComposing = false;
  hideCompositionPreview();
  const data = e.data || '';
  if (data) {
    // Single atomic send — even a single CJK char goes as paste so bracketed
    // markers frame it. Shells + repl libs that handle multibyte correctly
    // will still surface it as text; brackets are transparent to cooked mode.
    window.vc.send({ type: 'paste', data });
  }
  inputEl.value = '';
});

// Cache container padding — read from computed style instead of hardcoding
// CSS constants (which could drift if index.html changes the padding value).
// Refreshed on resize via ResizeObserver.
let containerPad = { left: 10, top: 12 };
function refreshContainerPad() {
  try {
    const cs = window.getComputedStyle(container);
    const pl = parseFloat(cs.paddingLeft);
    const pt = parseFloat(cs.paddingTop);
    if (!isNaN(pl)) containerPad.left = pl;
    if (!isNaN(pt)) containerPad.top = pt;
  } catch (_) {}
}

function showCompositionPreview(text) {
  if (!text) { hideCompositionPreview(); return; }
  // If viewport is scrolled up (user reading history), cursor is logically
  // off the visible area. Hide the preview — IME still functions, keystrokes
  // still route, user just doesn't see the overlay until they scroll back.
  // Acceptable — preview is an affordance, not an invariant.
  if (viewportLocked && vpOffset > 0) {
    hideCompositionPreview();
    return;
  }
  compositionEl.textContent = text;
  // Position at current cursor cell, relative to container's padding box.
  // Absolute elements position relative to container's border-box (container
  // has position:relative). Canvas paint (0,0) = padding-inside. So shift
  // compositionEl by padding to align with cell (0,0) of the canvas grid.
  const left = containerPad.left + (cur.x * cellW);
  const top = containerPad.top + (cur.y * cellH);
  compositionEl.style.left = `${left}px`;
  compositionEl.style.top = `${top}px`;
  compositionEl.classList.add('show');
}
function hideCompositionPreview() {
  compositionEl.classList.remove('show');
  compositionEl.textContent = '';
}

// Clipboard paste → bracketed paste via core.
inputEl.addEventListener('paste', (e) => {
  const text = e.clipboardData && e.clipboardData.getData('text');
  if (text) window.vc.send({ type: 'paste', data: text });
  e.preventDefault();
  // Clear textarea so the pasted text doesn't linger as its .value.
  setTimeout(() => { inputEl.value = ''; }, 0);
});

// Canvas/container clicks route focus to the invisible textarea (focus sink).
// MEOW audit 2026-04-24 #1: clicks on interactive overlays (quote-chip,
// new-output pill, scrollbar) can leave focus on those elements. Solution:
// a broad click-up handler on the terminal PANEL (not just container) that
// returns focus to inputEl after any click that isn't a text-input itself.
canvas.addEventListener('click', () => inputEl.focus());
const panelRight = document.getElementById('panel-right');
if (panelRight) {
  panelRight.addEventListener('mouseup', (e) => {
    // Skip if the click lands on a text-input-like element (palette, rename,
    // newnote overlays). Those elements own focus legitimately.
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    // Defer a tick so any click-driven UI transition (chip expand collapse)
    // finishes its own focus logic first; then steal back.
    setTimeout(() => { try { inputEl.focus(); } catch (_) {} }, 0);
  });
}
// On initial mount, focus the textarea so first keystrokes land somewhere.
window.addEventListener('load', () => {
  setTimeout(() => { try { inputEl.focus(); } catch (_) {} }, 50);
});

// Scrollback: mouse wheel + PgUp/PgDn/Ctrl+Home/Ctrl+End.
// In alt-screen (vim/less/top), wheel/PgUp forward as arrow keys so the app
// scrolls its own buffer. In normal screen, they move vc-core viewport.
const WHEEL_LINES_PER_TICK = 3;
// Roadmap #5: wheel events coalesce into a single rAF tick. A fast trackpad
// flick produces 40+ wheel events in <100 ms; sending 40+ JSONL messages
// backs up vc-core's stdin parser and visibly stutters. Accumulator flushes
// once per animation frame as a single {type:"scroll"} (or single key-burst
// in alt-screen). Clamped to ±rows per tick so momentum-scroll can't run
// away.
let pendingScrollLines = 0;          // normal-screen path
let pendingArrowCount = 0;           // alt-screen path, signed: + = Down, - = Up
let scrollRafScheduled = false;

function scheduleScrollFlush() {
  if (scrollRafScheduled) return;
  scrollRafScheduled = true;
  requestAnimationFrame(flushPendingScroll);
}

function flushPendingScroll() {
  scrollRafScheduled = false;
  // Clamp against current viewport height so one trackpad flick can't ship
  // a 200-line scroll request; user gets one page max per frame.
  //
  // MEOW aggregate audit #4: drain excess over later frames instead of
  // silently dropping. Subtract only what was shipped, then reschedule if
  // residual remains — preserves "one page per frame" rate-limit while
  // honoring the full magnitude of the flick.
  const cap = Math.max(1, rows);
  let residualLines = 0;
  let residualArrows = 0;
  if (pendingScrollLines !== 0) {
    const lines = Math.max(-cap, Math.min(cap, pendingScrollLines));
    pendingScrollLines -= lines;
    residualLines = pendingScrollLines;
    window.vc.send({ type: 'scroll', delta: lines });
    if (lines > 0) {
      setViewportLocked(true);
    }
  }
  if (pendingArrowCount !== 0) {
    const signed = Math.max(-cap, Math.min(cap, pendingArrowCount));
    pendingArrowCount -= signed;
    residualArrows = pendingArrowCount;
    const seq = signed > 0 ? '\x1b[B' : '\x1b[A';
    const n = Math.abs(signed);
    if (n > 0) {
      window.vc.send({ type: 'text', data: seq.repeat(n) });
    }
  }
  if (residualLines !== 0 || residualArrows !== 0) {
    scheduleScrollFlush();
  }
}

// ----- terminal selection (v0.4 #1) -----
// Selection model is a thin overlay on the local grid buffer. It exists ONLY
// when no mouse mode is active (vim/less own clicks otherwise). Selection
// rectangles render as composited DOM divs above the canvas (not DOM-per-cell
// — Invariant 9b). Drag = select; click without drag = clear; Esc = clear.
//   selection = { startRow, startCol, endRow, endCol } | null   (raw, not normalized)
//   selectionDragging = true while left button held after a no-mouse-mode mousedown.
// Variables hoisted to the top of the file (above resizeCanvasToContainer) to
// avoid TDZ during boot. Keep the initialization here too as a no-op for clarity.
selection = null;
selectionDragging = false;
selectionAnchor = null;   // { row, col } — fixed end of the drag

function hasSelection() {
  return selection !== null;
}

function clearSelection() {
  selection = null;
  selectionDragging = false;
  selectionAnchor = null;
  renderSelectionOverlay();
}

function setSelectionEnd(row, col) {
  if (!selectionAnchor) return;
  selection = {
    startRow: selectionAnchor.row,
    startCol: selectionAnchor.col,
    endRow: row,
    endCol: col,
  };
  renderSelectionOverlay();
}

function renderSelectionOverlay() {
  if (!selectionLayer) return;
  selectionLayer.innerHTML = '';
  if (!selection || cellW <= 0 || cellH <= 0) return;
  const sel = window.ptor && window.ptor.gridNormalize
    ? window.ptor.gridNormalize(selection)
    : selection;
  // Single row → one rect. Multi-row → 3 rects (first row partial, middle full
  // block, last row partial). All composited (transform/opacity only).
  const padL = containerPad.left;
  const padT = containerPad.top;
  const rects = [];
  if (sel.startRow === sel.endRow) {
    rects.push({
      x: Math.min(sel.startCol, sel.endCol),
      y: sel.startRow,
      w: Math.abs(sel.endCol - sel.startCol) + 1,
      h: 1,
    });
  } else {
    // First row: from startCol to row's right edge
    rects.push({ x: sel.startCol, y: sel.startRow, w: cols - sel.startCol, h: 1 });
    // Middle full rows
    if (sel.endRow - sel.startRow > 1) {
      rects.push({ x: 0, y: sel.startRow + 1, w: cols, h: sel.endRow - sel.startRow - 1 });
    }
    // Last row: from 0 to endCol
    rects.push({ x: 0, y: sel.endRow, w: sel.endCol + 1, h: 1 });
  }
  for (const r of rects) {
    const div = document.createElement('div');
    div.className = 'vc-selection-rect';
    div.style.left = (padL + r.x * cellW) + 'px';
    div.style.top = (padT + r.y * cellH) + 'px';
    div.style.width = (r.w * cellW) + 'px';
    div.style.height = (r.h * cellH) + 'px';
    selectionLayer.appendChild(div);
  }
}

function getSelectionText() {
  if (!selection) return '';
  if (window.ptor && window.ptor.gridExtract) {
    return window.ptor.gridExtract(grid, selection);
  }
  return '';
}

// v0.4 #2 — expose terminal-context accessors for the Ask overlay (renderer.js).
// Selection text first, else last-N visible lines from local grid buffer (no
// vc-core round-trip — overlay needs to be instant).
// v0.5 Phase 1 — Ghost overlay API. Renderer.js dispatches events to these.
const ghostScanEl    = document.getElementById('ghost-scan');
const ghostSuggestEl = document.getElementById('ghost-suggest');
const ghostStreamEl  = document.getElementById('ghost-stream');
let ghostScanTimer = null;

// P1 audit fix — Phase 4 router shim default. renderer.js sets this to the
// real router.notifyInteractive once router is created. Until then, calls to
// ghostDismiss() before renderer init won't throw.
if (typeof window.__ghostRouterNotify !== 'function') {
  window.__ghostRouterNotify = () => {};
}

function ghostScan(text, opts) {
  if (!ghostScanEl) return;
  opts = opts || {};
  const holdMs = opts.holdMs || 1400;
  ghostScanEl.textContent = text || '';
  ghostScanEl.classList.add('show');
  if (ghostScanTimer) clearTimeout(ghostScanTimer);
  ghostScanTimer = setTimeout(() => {
    ghostScanEl.classList.remove('show');
  }, holdMs);
}

function ghostSuggest(items, opts) {
  if (!ghostSuggestEl) return;
  if (!items || !items.length) {
    ghostSuggestEl.classList.remove('show');
    ghostSuggestEl.innerHTML = '';
    return;
  }
  const html = items.map((s, i) => `<div class="ghost-suggest-item">${i+1}. ${escapeHtml(String(s))}</div>`).join('');
  ghostSuggestEl.innerHTML = html;
  ghostSuggestEl.classList.add('show');
}

function ghostStream(token) {
  if (!ghostStreamEl) return;
  ghostStreamEl.classList.add('show');
  ghostStreamEl.classList.add('interactive');
  ghostStreamEl.textContent += token;
  ghostStreamEl.scrollTop = ghostStreamEl.scrollHeight;
}

function ghostStreamReset() {
  if (!ghostStreamEl) return;
  ghostStreamEl.textContent = '';
  ghostStreamEl.scrollTop = 0;
}

function ghostStreamEnd() {
  if (!ghostStreamEl) return;
  ghostStreamEl.classList.remove('interactive');
}

function ghostDismiss() {
  if (ghostScanEl) ghostScanEl.classList.remove('show');
  if (ghostSuggestEl) { ghostSuggestEl.classList.remove('show'); ghostSuggestEl.innerHTML = ''; }
  if (ghostStreamEl) {
    ghostStreamEl.classList.remove('show');
    ghostStreamEl.classList.remove('interactive');
    ghostStreamEl.textContent = '';
  }
  if (ghostScanTimer) { clearTimeout(ghostScanTimer); ghostScanTimer = null; }
  // v0.5 Phase 4 — tell router ghost is no longer interactive
  if (window.__ghostRouterNotify) {
    try { window.__ghostRouterNotify(false); } catch (_) {}
  }
}

// Local escape helper (vc-renderer is sandboxed; can't reach renderer.js's)
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

window.__vcView = {
  hasSelection: () => hasSelection(),
  getSelectionText: () => getSelectionText(),
  ghost: {
    scan: ghostScan,
    suggest: ghostSuggest,
    stream: ghostStream,
    streamReset: ghostStreamReset,
    streamEnd: ghostStreamEnd,
    dismiss: ghostDismiss,
  },
  // v0.5 Phase 6.0 — capture last LLM response from grid (pure module via preload)
  captureLastResponse: (opts) => {
    if (!window.ptor || typeof window.ptor.captureLastResponse !== 'function') {
      return { text: '', lineCount: 0, foundMarker: false, markerRow: -1 };
    }
    return window.ptor.captureLastResponse(grid, opts || {});
  },
  getRecentLines: (n) => {
    if (!grid || rows === 0) return '';
    const take = Math.max(1, Math.min(rows, n || 50));
    const start = rows - take;
    const out = [];
    for (let y = start; y < rows; y++) {
      const r = grid[y];
      if (!r) { out.push(''); continue; }
      let line = '';
      let x = 0;
      while (x < r.length) {
        const cell = r[x];
        if (!cell) { x++; continue; }
        line += cell.ch || ' ';
        x += (cell.wide === 2 ? 2 : 1);
      }
      out.push(line.replace(/\s+$/u, ''));
    }
    // Drop leading blank lines (terminal often has blank rows above content)
    while (out.length && out[0] === '') out.shift();
    return out.join('\n');
  },
};

// ----- mouse event reporting (roadmap #2) -----
// Listeners on #terminal-container; only forward when a mouse mode is active.
// Coordinates are 1-indexed cells (SGR convention). `offsetX/Y` is measured
// from the container's content box, which is where canvas mounts — no extra
// padding math required.
//
// Fallback order for wheel (critical — preserves #3 scroll-jump lock and #5
// rAF coalescing when NO mouse mode is active):
//   1. any mouse mode active → send as SGR wheel event (button 64/65)
//   2. alt-screen without mouse mode → wheel-to-arrow (existing #3/#5 path)
//   3. normal screen → scrollback via {type:"scroll"}
//
// For mousedown/mouseup/mousemove: if NO mouse mode is active, do nothing —
// don't swallow the event, don't preventDefault. Text selection is out of
// v0.3 scope but future work shouldn't have to fight this layer.

const MOUSE_MODIFIER_SHIFT = 0x04;
const MOUSE_MODIFIER_META = 0x08;
const MOUSE_MODIFIER_CTRL = 0x10;

function cellFromEvent(e) {
  if (cellW <= 0 || cellH <= 0) return null;
  // Anchor to the canvas rect, not event.offsetX/Y. The listener is on
  // #terminal-container, which has padding (12px 10px 36px) — events that
  // target the container's padding region would give an offset relative to
  // the container, not the canvas grid. getBoundingClientRect gives us a
  // stable canvas-origin reading regardless of which descendant received
  // the event.
  const rect = canvas.getBoundingClientRect();
  const lx = e.clientX - rect.left;
  const ly = e.clientY - rect.top;
  if (lx < 0 || ly < 0) return null;
  const col = Math.floor(lx / cellW) + 1;
  const row = Math.floor(ly / cellH) + 1;
  if (col < 1 || row < 1) return null;
  // Clamp to viewport so a click on the 1px gutter right of the last column
  // (due to cols = floor(cssW/cellW)) doesn't emit col > cols.
  return {
    x: Math.min(col, Math.max(1, cols)),
    y: Math.min(row, Math.max(1, rows)),
  };
}

function modsFromEvent(e) {
  let m = 0;
  if (e.shiftKey) m |= MOUSE_MODIFIER_SHIFT;
  if (e.altKey || e.metaKey) m |= MOUSE_MODIFIER_META;
  if (e.ctrlKey) m |= MOUSE_MODIFIER_CTRL;
  return m;
}

// Coalesce mousemove events via the same rAF gate the wheel coalescer uses
// (roadmap #5). Dragging across 80 cells at 120 Hz would otherwise flood the
// core with 300+ JSONL messages per second. We keep only the LATEST move
// position per frame — losing intermediate positions is fine because SGR
// move events are a best-effort approximation of a continuous cursor.
let pendingMouseMove = null; // { x, y, button, modifiers } or null
let mouseMoveRafScheduled = false;

function scheduleMouseMoveFlush() {
  if (mouseMoveRafScheduled) return;
  mouseMoveRafScheduled = true;
  requestAnimationFrame(flushPendingMouseMove);
}

function flushPendingMouseMove() {
  mouseMoveRafScheduled = false;
  if (!pendingMouseMove) return;
  const m = pendingMouseMove;
  pendingMouseMove = null;
  if (!anyMouseMode()) return; // mode toggled off between raf-schedule and flush
  window.vc.send({
    type: 'mouse',
    x: m.x,
    y: m.y,
    button: m.button,
    action: 'move',
    modifiers: m.modifiers,
  });
}

function sendMouseNow(x, y, button, action, modifiers) {
  window.vc.send({ type: 'mouse', x, y, button, action, modifiers });
}

container.addEventListener('mousedown', (e) => {
  // Selection path: only when no mouse mode AND left button.
  if (!anyMouseMode()) {
    if (e.button === 0) {
      const c = cellFromEvent(e);
      if (!c) return;
      // cellFromEvent returns 1-indexed; selection model uses 0-indexed grid coords.
      selectionAnchor = { row: c.y - 1, col: c.x - 1 };
      selection = {
        startRow: selectionAnchor.row,
        startCol: selectionAnchor.col,
        endRow: selectionAnchor.row,
        endCol: selectionAnchor.col,
      };
      selectionDragging = true;
      renderSelectionOverlay();
      // Don't preventDefault — let the click event still focus inputEl.
    }
    return;
  }
  // Mouse-mode path (vim/less): only 0/1/2 map to press reports.
  if (e.button > 2) return;
  const c = cellFromEvent(e);
  if (!c) return;
  heldButtons.add(e.button);
  sendMouseNow(c.x, c.y, e.button, 'press', modsFromEvent(e));
  e.preventDefault();
});

container.addEventListener('mouseup', (e) => {
  if (!anyMouseMode()) {
    if (selectionDragging && e.button === 0) {
      selectionDragging = false;
      // No drag (mouseup at same cell as mousedown anchor) → clear selection.
      if (selection
          && selection.startRow === selection.endRow
          && selection.startCol === selection.endCol) {
        clearSelection();
      }
    }
    return;
  }
  if (e.button > 2) return;
  const c = cellFromEvent(e);
  if (!c) return;
  heldButtons.delete(e.button);
  sendMouseNow(c.x, c.y, e.button, 'release', modsFromEvent(e));
  e.preventDefault();
});

container.addEventListener('mousemove', (e) => {
  if (!anyMouseMode()) {
    if (selectionDragging) {
      const c = cellFromEvent(e);
      if (c) setSelectionEnd(c.y - 1, c.x - 1);
    }
    return;
  }
  // Two scenarios where move reports make sense:
  //   - motion mode: all movement is tracked (\x1b[?1003h)
  //   - button mode with a held button: drag tracking (\x1b[?1002h)
  // Bare button mode without a held button does not report movement.
  const held = heldButtons.size > 0;
  if (!mouseMode.motion && !(mouseMode.button && held)) return;
  const c = cellFromEvent(e);
  if (!c) return;
  // Drag: report the first held button (same as alacritty/xterm behavior).
  // All-motion without a held button: SGR button number 3.
  const reportedButton = held ? heldButtons.values().next().value : 3;
  pendingMouseMove = {
    x: c.x,
    y: c.y,
    button: reportedButton,
    modifiers: modsFromEvent(e),
  };
  scheduleMouseMoveFlush();
  // Do NOT preventDefault on bare mousemove — no default action to suppress.
});

// Wheel bound to WINDOW capture phase + gated by container.contains(target).
// xterm.js binds to container div, but some Chromium builds appear to swallow
// wheel at canvas level without bubbling. Window-capture is the definitive path.
window.addEventListener('wheel', (e) => {
  const overTerminal = container && (container === e.target || container.contains(e.target));
  if (!overTerminal) return;
  // Roadmap #2 fallback priority: mouse mode wins over both alt-screen
  // wheel-to-arrow and normal scrollback. Send a single SGR wheel event per
  // browser wheel event — deliberately NOT rAF-coalesced because mouse
  // reports are semantic (each tick is a discrete action the app reads),
  // whereas scrollback lines are cumulative. Spamming 40+ per flick is still
  // cheaper than text repaints and no worse than a real mouse.
  if (anyMouseMode()) {
    const c = cellFromEvent(e);
    if (c) {
      const action = e.deltaY > 0 ? 'wheel_down' : 'wheel_up';
      const button = e.deltaY > 0 ? 65 : 64;
      sendMouseNow(c.x, c.y, button, action, modsFromEvent(e));
    }
    e.preventDefault();
    return;
  }
  if (altScreen) {
    // +WHEEL_LINES_PER_TICK for Down, -WHEEL_LINES_PER_TICK for Up.
    pendingArrowCount += e.deltaY > 0 ? WHEEL_LINES_PER_TICK : -WHEEL_LINES_PER_TICK;
  } else {
    // Up-wheel (deltaY < 0) = scroll up into history → positive scroll delta.
    pendingScrollLines += e.deltaY > 0 ? -WHEEL_LINES_PER_TICK : WHEEL_LINES_PER_TICK;
  }
  scheduleScrollFlush();
  e.preventDefault();
}, { passive: false, capture: true });

// Scroll keys — bound to window so focus can sit on canvas or container.
// Alt-screen bypass returns early → main canvas keydown forwards as escape seqs.
window.addEventListener('keydown', (e) => {
  // Only intercept when terminal panel is in logical focus path.
  // Accept inputEl (IME textarea, the real focus sink) OR canvas itself for
  // transitional states.
  if (!container.contains(document.activeElement) && document.activeElement !== canvas) return;
  if (isComposing || e.isComposing) return;  // defer to IME during composition
  if (altScreen) return;
  if (e.keyCode === 33 && !e.ctrlKey) {           // PgUp
    // Route through the #5 coalescer — key-repeat bursts (held PgUp) should
    // not produce 1 JSONL per event either. flushPendingScroll sets the lock.
    pendingScrollLines += rows;
    scheduleScrollFlush();
    e.preventDefault(); e.stopImmediatePropagation();
  } else if (e.keyCode === 34 && !e.ctrlKey) {    // PgDn
    pendingScrollLines -= rows;
    scheduleScrollFlush();
    e.preventDefault(); e.stopImmediatePropagation();
  } else if (e.keyCode === 36 && e.ctrlKey) {     // Ctrl+Home → Top
    window.vc.send({ type: 'scroll_top' });
    setViewportLocked(true);
    e.preventDefault(); e.stopImmediatePropagation();
  } else if (e.keyCode === 35 && e.ctrlKey) {     // Ctrl+End → Bottom
    window.vc.send({ type: 'scroll_bottom' });
    setViewportLocked(false);
    e.preventDefault(); e.stopImmediatePropagation();
  }
}, true);

// ----- ResizeObserver (9c: read-only; writes via rAF) -----
const ro = new ResizeObserver(() => {
  if (resizePending) return;
  resizePending = true;
  requestAnimationFrame(() => {
    resizePending = false;
    resizeCanvasToContainer();
    // Padding could change if CSS rules fire at resize breakpoints.
    refreshContainerPad();
  });
});
ro.observe(container);

// ----- boot -----
async function boot() {
  try { await document.fonts.ready; } catch {}
  measureCell();
  refreshContainerPad();
  resizeCanvasToContainer();
  // Focus the invisible textarea — that's the IME / keyboard sink. Canvas is
  // render-only now (tabindex=-1 in HTML).
  try { inputEl.focus(); } catch (_) { canvas.focus(); }
}

boot();

// Expose a programmatic write-text entry for SAGE/renderer.js "quote to agent" flow.
// Receives a raw string, forwards as text ClientMsg.
window.vcWriteText = (text) => {
  if (typeof text === 'string' && text.length > 0) {
    window.vc.send({ type: 'text', data: text });
  }
};

}  // end startVcRenderer
window.startVcRenderer = startVcRenderer;
