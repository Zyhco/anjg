/* Smooth scroller — inertial (lerp) mouse-wheel / trackpad scrolling + eased anchor & programmatic scrolling.
   No dependencies. Must load BEFORE main.js (classic script, no defer).
   Left untouched on purpose: touch scrolling, keyboard scrolling, scrollbar-thumb dragging, ctrl+wheel zoom,
   open <dialog>s and nested scrollable elements (textarea, command list…). Respects prefers-reduced-motion.

   Tweak the feel here:
     LERP   – fraction of the remaining distance covered per 60fps frame (lower = floatier, higher = snappier)
     WHEEL  – wheel distance multiplier (1 = same distance as native)                                          */
(() => {
  'use strict';

  const LERP = 0.1;
  const WHEEL = 1;

  const root = document.documentElement;
  const mqTouch = matchMedia('(hover:none)');                       // touch-first devices keep their native momentum scrolling
  const mqReduce = matchMedia('(prefers-reduced-motion:reduce)');
  const enabled = () => !mqTouch.matches && !mqReduce.matches;

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const maxScroll = () => Math.max(0, root.scrollHeight - root.clientHeight);
  const easeInOutCubic = p => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

  let cur = window.scrollY, tgt = cur, lastSet = cur;               // current / target / last position written by us
  let raf = 0, last = 0, tween = null;

  const stop = () => { if (raf) cancelAnimationFrame(raf); raf = 0; tween = null; };

  const apply = y => {
    const dpr = window.devicePixelRatio || 1;
    lastSet = Math.round(y * dpr) / dpr;                            // snap to device pixels: no sub-pixel shimmer
    window.scrollTo({ top: lastSet, behavior: 'instant' });
  };

  function frame(t) {
    raf = 0;
    const dt = clamp(t - last, 1, 64); last = t;

    if (tween) {                                                    // eased jump (anchor links, command palette…)
      const p = clamp((t - tween.t0) / tween.dur, 0, 1);
      cur = tween.from + (tween.to - tween.from) * easeInOutCubic(p);
      if (p >= 1) { cur = tgt = tween.to; tween = null; }
    } else {                                                        // wheel glide, frame-rate independent
      tgt = clamp(tgt, 0, maxScroll());
      cur += (tgt - cur) * (1 - Math.pow(1 - LERP, dt / 16.667));
      if (Math.abs(tgt - cur) < 0.25) cur = tgt;
    }

    apply(cur);
    if (tween || cur !== tgt) raf = requestAnimationFrame(frame);
  }

  const kick = () => { if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); } };

  // ---- wheel ----------------------------------------------------------------------------------------------------
  function nestedScroller(el, dy) {                                 // an inner element that can still scroll in this direction?
    for (; el && el !== document.body && el !== root; el = el.parentElement) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 1) {
        if (dy < 0 ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight - 1) return true;
      }
    }
    return false;
  }

  addEventListener('wheel', e => {
    if (e.defaultPrevented || e.ctrlKey || !enabled()) return;      // ctrl+wheel / pinch = browser zoom
    let dy = e.deltaY;
    if (!dy || Math.abs(e.deltaX) > Math.abs(dy)) return;           // horizontal gesture
    if (document.querySelector('dialog[open]')) return;             // command palette etc.
    if (nestedScroller(e.target, dy)) return;

    const max = maxScroll();
    if (max <= 0) return;
    if (!raf && (dy < 0 ? window.scrollY <= 0 : window.scrollY >= max - 1)) return;   // already at the edge: leave the native bounce alone

    if (e.deltaMode === 1) dy *= 40;                                // lines  -> px
    else if (e.deltaMode === 2) dy *= window.innerHeight;           // pages  -> px

    e.preventDefault();
    if (!raf) cur = tgt = lastSet = window.scrollY;                 // idle: start from the real position (lastSet too, so a late scroll event of an older move isn't mistaken for a new one)
    tween = null;                                                   // the user takes over from any running jump
    tgt = clamp(tgt + dy * WHEEL, 0, max);
    kick();
  }, { passive: false });

  // anything else that moves the page (keyboard, scrollbar thumb drag, find-in-page…) wins and re-syncs us
  addEventListener('scroll', () => {
    const y = window.scrollY;
    if (Math.abs(y - lastSet) > 2) { stop(); cur = tgt = lastSet = y; }
  }, { passive: true });

  // ---- programmatic scrolling -----------------------------------------------------------------------------------
  function resolve(target, offset) {
    if (typeof target === 'number') return target + offset;
    const el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!el) return null;
    const pad = parseFloat(getComputedStyle(root).scrollPaddingTop) || 0;      // same landing spot as native scrollIntoView
    const mar = parseFloat(getComputedStyle(el).scrollMarginTop) || 0;
    return el.getBoundingClientRect().top + window.scrollY - pad - mar + offset;
  }

  function to(target, opt = {}) {
    let y = resolve(target, opt.offset || 0);
    if (y == null) return;
    y = clamp(y, 0, maxScroll());

    if (!enabled()) { window.scrollTo({ top: y, behavior: mqReduce.matches ? 'auto' : 'smooth' }); return; }
    if (opt.immediate) { stop(); cur = tgt = y; apply(y); return; }

    if (!raf) cur = lastSet = window.scrollY;
    const dist = y - cur;
    if (Math.abs(dist) < 1) { stop(); cur = tgt = y; apply(y); return; }
    tgt = y;
    tween = { from: cur, to: y, t0: performance.now(), dur: clamp(500 + Math.abs(dist) * 0.35, 650, 1500) };
    kick();
  }

  // in-page links (#proyek, #tentang, …) glide instead of jumping
  document.addEventListener('click', e => {
    if (e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || !enabled()) return;
    const a = e.target.closest && e.target.closest('a[href^="#"]');
    if (!a || (a.target && a.target !== '_self')) return;
    let id = a.getAttribute('href').slice(1);
    try { id = decodeURIComponent(id); } catch { /* keep raw */ }
    const el = id ? document.getElementById(id) : null;
    if (id && !el) return;                                          // unknown target: let the browser decide
    e.preventDefault();
    to(el || 0);
    if (id) { try { history.pushState(null, '', '#' + id); } catch { /* file:// or sandboxed */ } }
  });

  // while active, the CSS `scroll-behavior:smooth` must be off, otherwise every scrollTo() above would be animated twice
  const sync = () => { root.classList.toggle('smooth-scroll', enabled()); if (!enabled()) stop(); };
  mqTouch.addEventListener('change', sync);
  mqReduce.addEventListener('change', sync);
  sync();

  window.SmoothScroll = { to, stop, get enabled() { return enabled(); } };
})();
