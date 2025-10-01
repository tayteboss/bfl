// Reusable IntersectionObserver that toggles 'in-view' on elements with [data-in-view]
(function () {
  function init() {
    var elements = Array.prototype.slice.call(document.querySelectorAll('[data-in-view]'));

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
            if (target.hasAttribute('data-in-view-once')) {
              observer.unobserve(target);
            }
          } else if (!target.hasAttribute('data-in-view-once')) {
            target.classList.remove('in-view');
          }
        });
      },
      { root: null, rootMargin: '-50px', threshold: 0.1 }
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
            observer.observe(node);
          }
          var nested = node.querySelectorAll ? node.querySelectorAll('[data-in-view]') : [];
          Array.prototype.slice.call(nested).forEach(function (el) {
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
