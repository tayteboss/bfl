/* FAQ accordion with Motion v12 (height on content, opacity on inner) */
(function () {
  'use strict';

  if (!window.Motion || !Motion.animate) return;
  var animate = Motion.animate;
  var SPRING_OPEN = { type: 'spring', stiffness: 600, damping: 20 };
  var SPRING_CLOSE = { type: 'spring', stiffness: 600, damping: 40 };

  function setHidden(el, hidden) {
    if (!el) return;
    if (hidden) el.setAttribute('hidden', '');
    else el.removeAttribute('hidden');
  }

  function open(btn, content) {
    var inner = content.querySelector('.faq-card__inner');
    btn.setAttribute('aria-expanded', 'true');
    setHidden(content, false);
    if (inner) inner.style.opacity = '0';

    var h = content.scrollHeight;
    content.style.overflow = 'hidden';
    var heightDone = animate(content, { height: [0, h] }, SPRING_OPEN).finished.then(function () {
      content.style.height = '';
      content.style.overflow = '';
    });
    var fadeDone = inner
      ? animate(inner, { opacity: [0, 1] }, { duration: 0.2, easing: 'ease-out', delay: 0.06 }).finished
      : Promise.resolve();
    return Promise.all([heightDone, fadeDone]);
  }

  function close(btn, content) {
    var inner = content.querySelector('.faq-card__inner');
    btn.setAttribute('aria-expanded', 'false');
    var h = content.scrollHeight;
    var fadeOut = inner
      ? animate(inner, { opacity: [1, 0] }, { duration: 0.2, easing: 'ease-in' }).finished
      : Promise.resolve();
    return fadeOut
      .then(function () {
        content.style.overflow = 'hidden';
        return animate(content, { height: [h, 0] }, SPRING_CLOSE).finished;
      })
      .then(function () {
        content.style.height = '';
        content.style.overflow = '';
        setHidden(content, true);
      });
  }

  function toggle(btn, content) {
    if (content.dataset.animating === '1') return;
    content.dataset.animating = '1';
    var willOpen = btn.getAttribute('aria-expanded') !== 'true';
    var p = willOpen ? open(btn, content) : close(btn, content);
    p.finally(function () {
      delete content.dataset.animating;
    });
  }

  function primeStates(root) {
    root.querySelectorAll('[data-faq-content]').forEach(function (content) {
      var inner = content.querySelector('.faq-card__inner');
      var btn = content.closest('.faq-card');
      var hidden = content.hasAttribute('hidden');
      if (btn) btn.setAttribute('aria-expanded', hidden ? 'false' : 'true');
      if (inner) inner.style.opacity = hidden ? '0' : '1';
    });
  }

  function bind(list) {
    if (!list || list._bound) return;
    list._bound = true;
    primeStates(list);
    list.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-faq-trigger]');
      if (!btn || !list.contains(btn)) return;
      var content = btn.querySelector('[data-faq-content]');
      if (!content) return;
      toggle(btn, content);
    });
  }

  function init() {
    document.querySelectorAll('[data-faq-list]').forEach(bind);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
  document.addEventListener('shopify:section:load', function (e) {
    var c = e.target || document;
    (
      c.querySelectorAll ||
      function () {
        return [];
      }
    )
      .call(c, '[data-faq-list]')
      .forEach(bind);
  });
})();
