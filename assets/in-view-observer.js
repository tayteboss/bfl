// Reusable IntersectionObserver that toggles 'in-view' on elements with [data-in-view]
(function () {
  function init() {
    var elements = Array.prototype.slice.call(document.querySelectorAll('[data-in-view]'));

    // Ensure initial hidden state for all targets
    elements.forEach(function (el) {
      if (!el.classList.contains('in-view-fade')) {
        el.classList.add('in-view-fade');
      }
    });

    if (!('IntersectionObserver' in window)) {
      elements.forEach(function (el) {
        el.classList.add('in-view');
      });
      return;
    }

    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          var target = entry.target;
          if (entry.isIntersecting) {
            target.classList.add('in-view');
            observer.unobserve(target); // always animate once
          }
        });
      },
      { root: null, rootMargin: '-75px', threshold: 0.1 }
    );

    elements.forEach(function (el) {
      observer.observe(el);
    });

    // Observe dynamically added nodes containing [data-in-view]
    var mo = new MutationObserver(function (mutations) {
      mutations.forEach(function (m) {
        if (m.type !== 'childList') return;
        Array.prototype.slice.call(m.addedNodes).forEach(function (node) {
          if (!(node instanceof HTMLElement)) return;
          if (node.hasAttribute && node.hasAttribute('data-in-view')) {
            if (!node.classList.contains('in-view-fade')) {
              node.classList.add('in-view-fade');
            }
            observer.observe(node);
          }
          var nested = node.querySelectorAll ? node.querySelectorAll('[data-in-view]') : [];
          Array.prototype.slice.call(nested).forEach(function (el) {
            if (!el.classList.contains('in-view-fade')) {
              el.classList.add('in-view-fade');
            }
            observer.observe(el);
          });
        });
      });
    });
    mo.observe(document.documentElement || document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
