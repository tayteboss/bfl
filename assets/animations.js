const SCROLL_ANIMATION_TRIGGER_CLASSNAME = 'scroll-trigger';
const SCROLL_ANIMATION_OFFSCREEN_CLASSNAME = 'scroll-trigger--offscreen';
const SCROLL_ZOOM_IN_TRIGGER_CLASSNAME = 'animate--zoom-in';
const SCROLL_ANIMATION_CANCEL_CLASSNAME = 'scroll-trigger--cancel';

// Scroll in animation logic
function onIntersection(elements, observer) {
  elements.forEach((element, index) => {
    if (element.isIntersecting) {
      const elementTarget = element.target;
      if (elementTarget.classList.contains(SCROLL_ANIMATION_OFFSCREEN_CLASSNAME)) {
        elementTarget.classList.remove(SCROLL_ANIMATION_OFFSCREEN_CLASSNAME);
        if (elementTarget.hasAttribute('data-cascade'))
          elementTarget.setAttribute('style', `--animation-order: ${index};`);
      }
      observer.unobserve(elementTarget);
    } else {
      element.target.classList.add(SCROLL_ANIMATION_OFFSCREEN_CLASSNAME);
      element.target.classList.remove(SCROLL_ANIMATION_CANCEL_CLASSNAME);
    }
  });
}

function initializeScrollAnimationTrigger(rootEl = document, isDesignModeEvent = false) {
  const animationTriggerElements = Array.from(rootEl.getElementsByClassName(SCROLL_ANIMATION_TRIGGER_CLASSNAME));
  if (animationTriggerElements.length === 0) return;

  if (isDesignModeEvent) {
    animationTriggerElements.forEach((element) => {
      element.classList.add('scroll-trigger--design-mode');
    });
    return;
  }

  const observer = new IntersectionObserver(onIntersection, {
    rootMargin: '0px 0px -50px 0px',
  });
  animationTriggerElements.forEach((element) => observer.observe(element));
}

// Zoom in animation logic
function initializeScrollZoomAnimationTrigger() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const animationTriggerElements = Array.from(document.getElementsByClassName(SCROLL_ZOOM_IN_TRIGGER_CLASSNAME));

  if (animationTriggerElements.length === 0) return;

  const scaleAmount = 0.2 / 100;

  animationTriggerElements.forEach((element) => {
    let elementIsVisible = false;
    const observer = new IntersectionObserver((elements) => {
      elements.forEach((entry) => {
        elementIsVisible = entry.isIntersecting;
      });
    });
    observer.observe(element);

    element.style.setProperty('--zoom-in-ratio', 1 + scaleAmount * percentageSeen(element));

    window.addEventListener(
      'scroll',
      throttle(() => {
        if (!elementIsVisible) return;

        element.style.setProperty('--zoom-in-ratio', 1 + scaleAmount * percentageSeen(element));
      }),
      { passive: true }
    );
  });
}

function percentageSeen(element) {
  const viewportHeight = window.innerHeight;
  const scrollY = window.scrollY;
  const elementPositionY = element.getBoundingClientRect().top + scrollY;
  const elementHeight = element.offsetHeight;

  if (elementPositionY > scrollY + viewportHeight) {
    // If we haven't reached the image yet
    return 0;
  } else if (elementPositionY + elementHeight < scrollY) {
    // If we've completely scrolled past the image
    return 100;
  }

  // When the image is in the viewport
  const distance = scrollY + viewportHeight - elementPositionY;
  let percentage = distance / ((viewportHeight + elementHeight) / 100);
  return Math.round(percentage);
}

// Hover shake animation for elements with [data-hover-shake]
function initializeHoverShake(rootEl = document) {
  try {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  } catch (e) {}

  const motionApi = window.motion || window.Motion;
  const hasAnimate = motionApi && typeof motionApi.animate === 'function';
  if (!hasAnimate) {
    window.addEventListener(
      'load',
      () => {
        initializeHoverShake(rootEl);
      },
      { once: true }
    );
  }

  const elements = Array.from(rootEl.querySelectorAll('[data-hover-shake]'));
  console.info('[hover-shake] init', { count: elements.length });

  elements.forEach((el) => registerHoverShakeOnElement(el));

  if (!document.__hoverShakeDelegated) {
    document.__hoverShakeDelegated = true;
    document.addEventListener(
      'pointerenter',
      (event) => {
        const el = event.target && event.target.closest ? event.target.closest('[data-hover-shake]') : null;
        if (!el) return;
        registerHoverShakeOnElement(el);
        if (hasAnimate) triggerHoverShake(el);
      },
      true
    );
    document.addEventListener('focusin', (event) => {
      const el = event.target && event.target.closest ? event.target.closest('[data-hover-shake]') : null;
      if (!el) return;
      registerHoverShakeOnElement(el);
      if (hasAnimate) triggerHoverShake(el);
    });
  }

  if (!rootEl.__hoverShakeObserved) {
    rootEl.__hoverShakeObserved = true;
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes &&
          mutation.addedNodes.forEach((node) => {
            if (!(node instanceof Element)) return;
            if (node.matches && node.matches('[data-hover-shake]')) registerHoverShakeOnElement(node);
            if (node.querySelectorAll)
              node.querySelectorAll('[data-hover-shake]').forEach((el) => registerHoverShakeOnElement(el));
          });
      });
    });
    observer.observe(rootEl === document ? document.body : rootEl, { childList: true, subtree: true });
  }
}

function registerHoverShakeOnElement(el) {
  if (el.__hoverShakeBound) return;
  el.__hoverShakeBound = true;

  const onEnter = () => triggerHoverShake(el);
  el.addEventListener('mouseenter', onEnter);
  el.addEventListener('focus', onEnter);
}

function triggerHoverShake(el) {
  const motionApi = window.motion || window.Motion;
  if (!motionApi || typeof motionApi.animate !== 'function') return;

  if (!el.style.transformOrigin) {
    const hoverShakeRaw = el.dataset && el.dataset.hoverShake ? el.dataset.hoverShake.toLowerCase() : '';
    el.style.transformOrigin = hoverShakeRaw === 'left' ? '0% 50%' : '50% 50%';
  }

  if (el.__hoverShakeAnimation && typeof el.__hoverShakeAnimation.cancel === 'function') {
    el.__hoverShakeAnimation.cancel();
  }

  const { rotate, y, duration } = getShakeConfig(el);

  el.__hoverShakeAnimation = motionApi.animate(el, { rotate, y }, { duration, easing: 'ease-in-out' });

  if (
    el.__hoverShakeAnimation &&
    el.__hoverShakeAnimation.finished &&
    typeof el.__hoverShakeAnimation.finished.finally === 'function'
  ) {
    el.__hoverShakeAnimation.finished.finally(() => {
      el.__hoverShakeAnimation = null;
    });
  }
}

function getShakeConfig(el) {
  const raw = (
    (el.dataset && (el.dataset.hoverShake || el.dataset.shakeSize || el.dataset.hoverShakeSize)) ||
    ''
  ).toLowerCase();
  const isSmall = raw === 'small' || raw === 'sm' || raw === 's' || raw === 'mini';

  if (isSmall) {
    return {
      rotate: [0, -3, 3, -2, 2, -1, 1, 0],
      y: [0, -1, 1, 0],
      duration: 0.24,
    };
  }

  return {
    rotate: [0, -5, 5, -3, 3, -2, 2, 0],
    y: [0, -3, 2, 0],
    duration: 0.3,
  };
}

if (Shopify.designMode) {
  document.addEventListener('shopify:section:load', (event) => {
    initializeScrollAnimationTrigger(event.target, true);
    initializeHoverShake(event.target);
  });
  document.addEventListener('shopify:section:reorder', () => initializeScrollAnimationTrigger(document, true));
}

// FAQ accordion with Motion v12 (height on content, opacity on inner)
function initializeFAQAccordions(rootEl = document) {
  if (!window.Motion || !Motion.animate) return;
  const animate = Motion.animate;
  const SPRING_OPEN = { type: 'spring', stiffness: 600, damping: 20 };
  const SPRING_CLOSE = { type: 'spring', stiffness: 600, damping: 40 };

  function setHidden(el, hidden) {
    if (!el) return;
    if (hidden) el.setAttribute('hidden', '');
    else el.removeAttribute('hidden');
  }

  function open(btn, content) {
    const inner = content.querySelector('.faq-card__inner');
    btn.setAttribute('aria-expanded', 'true');
    setHidden(content, false);
    if (inner) inner.style.opacity = '0';

    const h = content.scrollHeight;
    content.style.overflow = 'hidden';
    const heightDone = animate(content, { height: [0, h] }, SPRING_OPEN).finished.then(() => {
      content.style.height = '';
      content.style.overflow = '';
    });
    const fadeDone = inner
      ? animate(inner, { opacity: [0, 1] }, { duration: 0.2, easing: 'ease-out', delay: 0.06 }).finished
      : Promise.resolve();
    return Promise.all([heightDone, fadeDone]);
  }

  function close(btn, content) {
    const inner = content.querySelector('.faq-card__inner');
    btn.setAttribute('aria-expanded', 'false');
    const h = content.scrollHeight;
    const fadeOut = inner
      ? animate(inner, { opacity: [1, 0] }, { duration: 0.2, easing: 'ease-in' }).finished
      : Promise.resolve();
    return fadeOut
      .then(() => {
        content.style.overflow = 'hidden';
        return animate(content, { height: [h, 0] }, SPRING_CLOSE).finished;
      })
      .then(() => {
        content.style.height = '';
        content.style.overflow = '';
        setHidden(content, true);
      });
  }

  function toggle(btn, content) {
    if (content.dataset.animating === '1') return;
    content.dataset.animating = '1';
    const willOpen = btn.getAttribute('aria-expanded') !== 'true';
    const p = willOpen ? open(btn, content) : close(btn, content);
    p.finally(() => {
      delete content.dataset.animating;
    });
  }

  function primeStates(root) {
    root.querySelectorAll('[data-faq-content]').forEach((content) => {
      const inner = content.querySelector('.faq-card__inner');
      const btn = content.closest('.faq-card');
      const hidden = content.hasAttribute('hidden');
      if (btn) btn.setAttribute('aria-expanded', hidden ? 'false' : 'true');
      if (inner) inner.style.opacity = hidden ? '0' : '1';
    });
  }

  function bind(list) {
    if (!list || list._bound) return;
    list._bound = true;
    primeStates(list);
    list.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-faq-trigger]');
      if (!btn || !list.contains(btn)) return;
      const content = btn.querySelector('[data-faq-content]');
      if (!content) return;
      toggle(btn, content);
    });
  }

  rootEl.querySelectorAll('[data-faq-list]').forEach(bind);
}

// Simple gear accordion (no animations)
function initializeGearAccordions(rootEl = document) {
  function toggle(btn, content) {
    const isExpanded = btn.getAttribute('aria-expanded') === 'true';
    btn.setAttribute('aria-expanded', !isExpanded);

    if (isExpanded) {
      content.setAttribute('hidden', '');
    } else {
      content.removeAttribute('hidden');
    }
  }

  function bind(list) {
    if (!list || list._bound) return;
    list._bound = true;

    list.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-gear-accordion-trigger]');
      if (!btn || !list.contains(btn)) return;
      let content = btn.querySelector('[data-gear-accordion-content]');
      if (!content) {
        const controlsId = btn.getAttribute('aria-controls');
        if (controlsId) content = document.getElementById(controlsId);
      }
      if (!content) {
        const maybeSibling = btn.nextElementSibling;
        if (maybeSibling && maybeSibling.matches && maybeSibling.matches('[data-gear-accordion-content]')) {
          content = maybeSibling;
        }
      }
      if (!content) return;
      toggle(btn, content);
    });
  }

  rootEl.querySelectorAll('[data-gear-accordion-list]').forEach(bind);
}

if (Shopify.designMode) {
  document.addEventListener('shopify:section:load', (event) => {
    initializeScrollAnimationTrigger(event.target, true);
    initializeHoverShake(event.target);
    initializeFAQAccordions(event.target);
    initializeGearAccordions(event.target);
  });
  document.addEventListener('shopify:section:reorder', () => initializeScrollAnimationTrigger(document, true));
}

window.addEventListener('DOMContentLoaded', () => {
  initializeScrollAnimationTrigger();
  initializeScrollZoomAnimationTrigger();
  initializeHoverShake();
  initializeFAQAccordions();
  initializeGearAccordions();
});
