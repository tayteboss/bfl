(function () {
  if (typeof window === 'undefined') return;

  var prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReduced) return;

  var instances = [];
  var visibleInstances = new Set();
  var running = false;
  var io;

  function clamp(value, min, max) {
    return value < min ? min : value > max ? max : value;
  }

  function parseStrength(el, axis) {
    var attr =
      el.getAttribute('data-parallax-strength' + (axis ? '-' + axis : '')) || el.getAttribute('data-parallax-strength');
    if (!attr) return 40; // default px
    if (typeof attr === 'string' && attr.trim().endsWith('%')) {
      var percent = parseFloat(attr);
      if (isNaN(percent)) return 40;
      return (percent / 100) * (axis === 'x' ? window.innerWidth : window.innerHeight);
    }
    var n = parseFloat(attr);
    return isNaN(n) ? 40 : n;
  }

  function createInstance(el) {
    if (el.__parallax) return el.__parallax;

    var axis = (el.getAttribute('data-parallax-axis') || 'y').toLowerCase();
    var invert = el.hasAttribute('data-parallax-invert');
    var lerp = parseFloat(el.getAttribute('data-parallax-lerp'));
    if (isNaN(lerp)) lerp = 0.15; // 0..1

    var strengthX = axis === 'y' ? 0 : parseStrength(el, 'x');
    var strengthY = axis === 'x' ? 0 : parseStrength(el, 'y');

    var state = {
      el: el,
      axis: axis,
      invert: invert,
      lerp: clamp(lerp, 0.01, 0.5),
      strengthX: strengthX,
      strengthY: strengthY,
      currentX: 0,
      currentY: 0,
      targetX: 0,
      targetY: 0,
      visible: false,
    };

    el.style.transform = el.style.transform || 'translate3d(0, 0, 0)';
    el.style.willChange = 'transform';

    el.__parallax = state;
    instances.push(state);

    if (!io) initIO();
    io.observe(el);

    return state;
  }

  function initIO() {
    io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          var st = entry.target.__parallax;
          if (!st) return;
          st.visible = entry.isIntersecting;
          if (st.visible) {
            visibleInstances.add(st);
            start();
          } else {
            visibleInstances.delete(st);
          }
        });
      },
      { root: null, rootMargin: '0px 0px 0px 0px', threshold: 0 }
    );
  }

  function updateTargets() {
    // compute target transform based on element position relative to viewport center
    visibleInstances.forEach(function (st) {
      var rect = st.el.getBoundingClientRect();

      var viewportCenterX = window.innerWidth * 0.5;
      var viewportCenterY = window.innerHeight * 0.5;
      var elementCenterX = rect.left + rect.width * 0.5;
      var elementCenterY = rect.top + rect.height * 0.5;

      var dx = elementCenterX - viewportCenterX;
      var dy = elementCenterY - viewportCenterY;

      // normalize to [-1, 1]
      var nx = clamp(dx / viewportCenterX, -1, 1);
      var ny = clamp(dy / viewportCenterY, -1, 1);

      var dir = st.invert ? -1 : 1;
      st.targetX = dir * nx * st.strengthX;
      st.targetY = dir * ny * st.strengthY;
    });
  }

  function tick() {
    if (!running) return;
    var stillAnimating = false;

    visibleInstances.forEach(function (st) {
      // ease towards target
      st.currentX += (st.targetX - st.currentX) * st.lerp;
      st.currentY += (st.targetY - st.currentY) * st.lerp;

      if (Math.abs(st.targetX - st.currentX) > 0.05 || Math.abs(st.targetY - st.currentY) > 0.05) {
        stillAnimating = true;
      }

      var tx = st.currentX.toFixed(3) + 'px';
      var ty = st.currentY.toFixed(3) + 'px';
      st.el.style.transform = 'translate3d(' + tx + ', ' + ty + ', 0)';
    });

    if (!stillAnimating && visibleInstances.size === 0) {
      running = false;
      return;
    }

    window.requestAnimationFrame(tick);
  }

  function start() {
    if (running) return;
    running = true;
    window.requestAnimationFrame(tick);
  }

  function bindScroll() {
    var handler = function () {
      if (visibleInstances.size === 0) return;
      updateTargets();
      start();
    };

    if (window.ScrollUtils && typeof window.ScrollUtils.onScroll === 'function') {
      window.ScrollUtils.onScroll(handler);
    } else {
      window.addEventListener('scroll', handler, { passive: true });
    }

    window.addEventListener('resize', function () {
      updateTargets();
      start();
    });
  }

  function scan() {
    var els = document.querySelectorAll('[data-parallax]');
    els.forEach(createInstance);
    updateTargets();
    start();
  }

  function observeMutations() {
    var mo = new MutationObserver(function (mutations) {
      mutations.forEach(function (m) {
        if (m.type !== 'childList') return;
        Array.prototype.slice.call(m.addedNodes).forEach(function (node) {
          if (!(node instanceof HTMLElement)) return;
          if (node.hasAttribute && node.hasAttribute('data-parallax')) createInstance(node);
          var nested = node.querySelectorAll ? node.querySelectorAll('[data-parallax]') : [];
          Array.prototype.slice.call(nested).forEach(createInstance);
        });
      });
    });
    mo.observe(document.documentElement || document.body, { childList: true, subtree: true });
  }

  function init() {
    scan();
    bindScroll();
    observeMutations();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
