(function () {
  const subscribers = new Set();
  let lastX = 0;
  let lastY = 0;
  let ticking = false;

  function localThrottle(fn, delay) {
    let lastCall = 0;
    return function throttled() {
      const now = Date.now();
      if (now - lastCall < delay) return;
      lastCall = now;
      return fn.apply(this, arguments);
    };
  }

  function notifyAll(x, y) {
    subscribers.forEach(function (cb) {
      try {
        cb({ x: x, y: y });
      } catch (e) {
        console.error(e);
      }
    });
  }

  const throttleFn = typeof _ !== 'undefined' && typeof _.throttle === 'function' ? _.throttle : localThrottle;

  const handleMove = throttleFn(function (evt) {
    if (evt && typeof evt.touches !== 'undefined' && evt.touches.length > 0) {
      lastX = evt.touches[0].clientX || 0;
      lastY = evt.touches[0].clientY || 0;
    } else if (evt) {
      lastX = evt.clientX || 0;
      lastY = evt.clientY || 0;
    }
    if (!ticking) {
      window.requestAnimationFrame(function () {
        notifyAll(lastX, lastY);
        ticking = false;
      });
      ticking = true;
    }
  }, 16); // ~60fps default

  function onMove(callback) {
    if (typeof callback !== 'function') return function () {};
    if (subscribers.size === 0) {
      window.addEventListener('mousemove', handleMove, { passive: true });
      window.addEventListener('touchmove', handleMove, { passive: true });
    }
    subscribers.add(callback);
    // fire once with current position (defaults to 0,0 until first move)
    callback({ x: lastX, y: lastY });
    return function unsubscribe() {
      subscribers.delete(callback);
      if (subscribers.size === 0) {
        window.removeEventListener('mousemove', handleMove);
        window.removeEventListener('touchmove', handleMove);
      }
    };
  }

  window.CursorUtils = {
    onMove: onMove,
  };
})();
