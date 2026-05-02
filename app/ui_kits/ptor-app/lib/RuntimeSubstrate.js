/* global window */
// Hypha Lacquer Loop — Motion-as-Signal substrate bus (W7 v1.0).
// Plan: C:\Users\32043\.claude\plans\flickering-tickling-koala.md
//
// Single global EventTarget exposing 4 signals to the renderer's motion
// components. ALL motion in Hypha must read from here — pure decoration is
// banned by constitution. State shape:
//   { a1Cure:0..1, a2Delta:0..1, p:'P1'..'F3'|null, archetype:string|null, motionLevel }
//
// Feeders (wired in v1.1+):
//   curriculum:progress IPC → a1Cure
//   lesson:stream-chunk    → a2Delta from prediction-error judge
//   methodTags emit on lesson finish → p
//   archetype field on state.json → archetype
//
// rAF-throttled to 60Hz max emission. Single MOTION_LEVEL constant at top is
// the global rollback lever — set to 'off' to return all components to their
// pre-motion render in 1 line.

(function () {
  'use strict';

  // Global rollback lever — flip to 'quiet' or 'off' if motion harms register.
  // Auto-honors prefers-reduced-motion (forces 'quiet').
  var MOTION_LEVEL = 'full';

  var prefersReduced = false;
  try {
    prefersReduced = window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (_) {}
  if (prefersReduced) MOTION_LEVEL = 'quiet';

  var bus = new EventTarget();
  var state = {
    a1Cure: 0,
    a2Delta: 0,
    p: null,
    archetype: null,
    motionLevel: MOTION_LEVEL,
  };

  // rAF-throttled commit — coalesce multiple set() calls within one frame.
  var pendingPatch = null;
  var rafId = 0;
  function flush() {
    rafId = 0;
    if (!pendingPatch) return;
    var patch = pendingPatch;
    pendingPatch = null;
    var changed = false;
    for (var k in patch) {
      if (state[k] !== patch[k]) { state[k] = patch[k]; changed = true; }
    }
    if (changed) bus.dispatchEvent(new CustomEvent('substrate:update', { detail: { state: state } }));
  }

  function set(patch) {
    if (!patch || typeof patch !== 'object') return;
    pendingPatch = pendingPatch ? Object.assign(pendingPatch, patch) : Object.assign({}, patch);
    if (!rafId) rafId = (typeof requestAnimationFrame === 'function')
      ? requestAnimationFrame(flush) : setTimeout(flush, 16);
  }

  function get() { return Object.assign({}, state); }

  function subscribe(cb) {
    if (typeof cb !== 'function') return function () {};
    var handler = function (e) { cb(e.detail.state); };
    bus.addEventListener('substrate:update', handler);
    cb(state); // emit current state immediately
    return function () { bus.removeEventListener('substrate:update', handler); };
  }

  // useSubstrate React hook — reads current state, re-renders on update.
  // Returns the state object directly; consumers destructure.
  function useSubstrate() {
    if (!window.React) return state;
    var R = window.React;
    var ref = R.useRef(state);
    var forceUpdate = R.useReducer(function (n) { return n + 1; }, 0)[1];
    R.useEffect(function () {
      var unsub = subscribe(function (next) {
        ref.current = next;
        forceUpdate();
      });
      return unsub;
    }, []);
    return ref.current;
  }

  // setMotionLevel('full' | 'quiet' | 'off') — runtime override for diagnostics.
  function setMotionLevel(level) {
    if (level === 'full' || level === 'quiet' || level === 'off') {
      set({ motionLevel: level });
    }
  }

  window.RuntimeSubstrate = {
    set: set,
    get: get,
    subscribe: subscribe,
    useSubstrate: useSubstrate,
    setMotionLevel: setMotionLevel,
  };
})();
