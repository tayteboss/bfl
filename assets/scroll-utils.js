// Lightweight scroll position utility with throttle and subscription API

(function () {
  const subscribers = new Set();
  let lastKnownY = 0;
  let ticking = false;

  function localThrottle(fn, delay) {
    let lastCall = 0;
    return function (...args) {
      const now = Date.now();
      if (now - lastCall < delay) return;
      lastCall = now;
      return fn.apply(this, args);
    };
  }

  function notifyAll(y) {
    subscribers.forEach((cb) => {
      try {
        cb(y);
      } catch (e) {
        console.error(e);
      }
    });
  }

  const throttleFn = typeof _ !== 'undefined' && typeof _.throttle === 'function' ? _.throttle : localThrottle;

  const handleScroll = throttleFn(function () {
    lastKnownY = window.scrollY || window.pageYOffset || 0;
    if (!ticking) {
      window.requestAnimationFrame(function () {
        notifyAll(lastKnownY);
        ticking = false;
      });
      ticking = true;
    }
  }, 100);

  function onScroll(callback) {
    if (typeof callback !== 'function') return function () {};
    if (subscribers.size === 0) {
      window.addEventListener('scroll', handleScroll, { passive: true });
    }
    subscribers.add(callback);
    // fire once with current position so consumers get initial state
    callback(window.scrollY || window.pageYOffset || 0);
    return function unsubscribe() {
      subscribers.delete(callback);
      if (subscribers.size === 0) {
        window.removeEventListener('scroll', handleScroll);
      }
    };
  }

  function isScrolledBeyond(amount) {
    const y = window.scrollY || window.pageYOffset || 0;
    return y > (typeof amount === 'number' ? amount : 100);
  }

  window.ScrollUtils = {
    onScroll,
    isScrolledBeyond,
  };
})();
