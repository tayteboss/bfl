class CartDrawer extends HTMLElement {
  constructor() {
    super();
    this.addEventListener('keyup', (evt) => evt.code === 'Escape' && this.close());
  }

  connectedCallback() {
    // Set up overlay click handler
    this.setupOverlayClick();

    // Set up header cart icon
    this.setHeaderCartIconAccessibility();
  }

  setupOverlayClick() {
    const overlay = this.querySelector('#CartDrawer-Overlay');
    if (overlay) {
      // Remove any existing listeners to prevent duplicates
      overlay.replaceWith(overlay.cloneNode(true));
      const newOverlay = this.querySelector('#CartDrawer-Overlay');
      newOverlay.addEventListener('click', (e) => {
        e.stopPropagation();
        this.close();
      });
    }
  }

  setHeaderCartIconAccessibility() {
    const cartLink = document.querySelector('#cart-icon-bubble');
    if (!cartLink) return;

    cartLink.setAttribute('role', 'button');
    cartLink.setAttribute('aria-haspopup', 'dialog');
    cartLink.addEventListener('click', (event) => {
      event.preventDefault();
      this.open(cartLink);
    });
    cartLink.addEventListener('keydown', (event) => {
      if (event.code.toUpperCase() === 'SPACE') {
        event.preventDefault();
        this.open(cartLink);
      }
    });
  }

  open(triggeredBy) {
    if (triggeredBy) this.setActiveElement(triggeredBy);
    const cartDrawerNote = this.querySelector('[id^="Details-"] summary');
    if (cartDrawerNote && !cartDrawerNote.hasAttribute('role')) this.setSummaryAccessibility(cartDrawerNote);
    // here the animation doesn't seem to always get triggered. A timeout seem to help
    setTimeout(() => {
      this.classList.add('animate', 'active');
    });

    this.addEventListener(
      'transitionend',
      () => {
        const containerToTrapFocusOn = this.classList.contains('is-empty')
          ? this.querySelector('.drawer__inner-empty')
          : document.getElementById('CartDrawer');
        const focusElement = this.querySelector('.drawer__inner') || this.querySelector('.drawer__close');
        if (containerToTrapFocusOn && typeof trapFocus === 'function') {
          trapFocus(containerToTrapFocusOn, focusElement);
        }
      },
      { once: true }
    );

    document.body.classList.add('overflow-hidden');
  }

  close() {
    this.classList.remove('active');
    if (typeof removeTrapFocus === 'function') {
      removeTrapFocus(this.activeElement);
    }
    document.body.classList.remove('overflow-hidden');
  }

  setSummaryAccessibility(cartDrawerNote) {
    cartDrawerNote.setAttribute('role', 'button');
    cartDrawerNote.setAttribute('aria-expanded', 'false');

    if (cartDrawerNote.nextElementSibling.getAttribute('id')) {
      cartDrawerNote.setAttribute('aria-controls', cartDrawerNote.nextElementSibling.id);
    }

    cartDrawerNote.addEventListener('click', (event) => {
      event.currentTarget.setAttribute('aria-expanded', !event.currentTarget.closest('details').hasAttribute('open'));
    });

    cartDrawerNote.parentElement.addEventListener('keyup', onKeyUpEscape);
  }

  renderContents(parsedState) {
    if (!parsedState) {
      console.error('No parsed state provided to renderContents');
      return;
    }

    // Clear empty state classes on the host and items wrapper
    this.classList.remove('is-empty');
    const itemsWrapper = this.querySelector('cart-drawer-items');
    if (itemsWrapper) itemsWrapper.classList.remove('is-empty');

    const drawerInner = this.querySelector('.drawer__inner');
    if (drawerInner && drawerInner.classList.contains('is-empty')) {
      drawerInner.classList.remove('is-empty');
    }
    const emptyInner = this.querySelector('.drawer__inner-empty');
    if (emptyInner) emptyInner.remove();

    if (parsedState.id) {
      this.productId = parsedState.id;
    }

    if (parsedState.sections) {
      this.getSectionsToRender().forEach((section) => {
        if (!parsedState.sections[section.id]) {
          console.warn(`Section ${section.id} not found in response`);
          return;
        }

        const sectionElement = section.selector
          ? document.querySelector(section.selector)
          : document.getElementById(section.id);

        if (!sectionElement) {
          console.warn(`Section element not found for ${section.id} with selector ${section.selector}`);
          return;
        }

        try {
          const sectionHTML = this.getSectionInnerHTML(parsedState.sections[section.id], section.selector);
          if (sectionHTML) {
            sectionElement.innerHTML = sectionHTML;
          }
        } catch (e) {
          console.error(`Error rendering section ${section.id}:`, e);
        }
      });
    } else {
      console.warn('No sections in parsed state response');
    }

    // Publish cart update event to sync header counts
    // Fetch current cart state to get accurate item_count
    if (typeof publish === 'function' && typeof PUB_SUB_EVENTS !== 'undefined' && typeof routes !== 'undefined') {
      fetch(`${routes.cart_url}.js`)
        .then((res) => res.json())
        .then((cart) => {
          // If the cart isn't empty, ensure empty classes are removed
          if (cart && Array.isArray(cart.items) && cart.items.length > 0) {
            this.classList.remove('is-empty');
            const iw = this.querySelector('cart-drawer-items');
            if (iw) iw.classList.remove('is-empty');
            const emptyBlock = this.querySelector('.drawer__inner-empty');
            if (emptyBlock) emptyBlock.remove();

            // If DOM doesn't yet have the items list (first add race), fetch the section fresh
            const hasItemsList = !!this.querySelector('.cart-items-list');
            if (!hasItemsList && typeof routes !== 'undefined') {
              fetch(`${routes.cart_url}?section_id=cart-drawer`)
                .then((r) => r.text())
                .then((html) => {
                  const sections = { 'cart-drawer': html };
                  // Re-render only the drawer section
                  const sectionHTML = this.getSectionInnerHTML(sections['cart-drawer'], '#CartDrawer');
                  const sectionElement = document.querySelector('#CartDrawer');
                  if (sectionElement && sectionHTML) {
                    sectionElement.innerHTML = sectionHTML;
                  }
                })
                .catch(() => {});
            }
          }
          publish(PUB_SUB_EVENTS.cartUpdate, {
            source: 'cart-drawer',
            cartData: {
              item_count: cart.item_count,
              items: cart.items,
              total_quantity: cart.total_quantity,
            },
          });
        })
        .catch((e) => {
          console.error('Cart drawer: error fetching cart state:', e);
          // Fallback: try to extract from parsedState
          if (parsedState.item_count !== undefined) {
            publish(PUB_SUB_EVENTS.cartUpdate, {
              source: 'cart-drawer',
              cartData: {
                item_count: parsedState.item_count,
                items: parsedState.items,
                total_quantity: parsedState.total_quantity,
              },
            });
          } else if (Array.isArray(parsedState.items)) {
            publish(PUB_SUB_EVENTS.cartUpdate, {
              source: 'cart-drawer',
              cartData: {
                item_count: parsedState.items.length,
                items: parsedState.items,
              },
            });
          }
        });
    }

    setTimeout(() => {
      // Re-setup overlay click after content update
      this.setupOverlayClick();
      this.open();
    }, 100);
  }

  getSectionInnerHTML(html, selector = '.shopify-section') {
    try {
      const parsed = new DOMParser().parseFromString(html, 'text/html');

      // First try to find the element by the provided selector
      let element = parsed.querySelector(selector);

      // If selector is '#CartDrawer', we need to look inside the .shopify-section wrapper
      if (!element && selector === '#CartDrawer') {
        const shopifySection = parsed.querySelector('.shopify-section');
        if (shopifySection) {
          element =
            shopifySection.querySelector('#CartDrawer') ||
            shopifySection.querySelector('cart-drawer') ||
            shopifySection;
        }
      }

      // If still not found, try alternative selectors
      if (!element) {
        element =
          parsed.querySelector('cart-drawer') ||
          parsed.querySelector('#CartDrawer') ||
          parsed.querySelector('.shopify-section');
      }

      // If we found an element, return its innerHTML
      if (element) {
        // If it's the cart-drawer custom element, get the inner content
        if (element.tagName === 'CART-DRAWER') {
          return element.innerHTML;
        }
        // If it's #CartDrawer, get its innerHTML
        if (element.id === 'CartDrawer') {
          return element.innerHTML;
        }
        // Otherwise return the element's innerHTML
        return element.innerHTML;
      }

      // Fallback: return the body content
      return parsed.body ? parsed.body.innerHTML : html;
    } catch (e) {
      console.error('Error parsing section HTML:', e);
      return html;
    }
  }

  getSectionsToRender() {
    return [
      {
        id: 'cart-drawer',
        selector: '#CartDrawer',
      },
      {
        id: 'cart-icon-bubble',
      },
    ];
  }

  getSectionDOM(html, selector = '.shopify-section') {
    return new DOMParser().parseFromString(html, 'text/html').querySelector(selector);
  }

  setActiveElement(element) {
    this.activeElement = element;
  }
}

customElements.define('cart-drawer', CartDrawer);

class CartDrawerItems extends CartItems {
  getSectionsToRender() {
    return [
      {
        id: 'CartDrawer',
        section: 'cart-drawer',
        selector: '.drawer__inner',
      },
      {
        id: 'cart-icon-bubble',
        section: 'cart-icon-bubble',
        selector: '.shopify-section',
      },
    ];
  }
}

customElements.define('cart-drawer-items', CartDrawerItems);
