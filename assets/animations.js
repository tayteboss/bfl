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
    el.style.transformOrigin = '50% 50%';
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

window.addEventListener('DOMContentLoaded', () => {
  initializeScrollAnimationTrigger();
  initializeScrollZoomAnimationTrigger();
  initializeHoverShake();
});
