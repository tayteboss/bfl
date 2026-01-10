/* -------------------------------------------------
   CART.JS — Your version merged w/ KEY removal fix
---------------------------------------------------*/

class CartRemoveButton extends HTMLElement {
  constructor() {
    super();

    this.addEventListener('click', (event) => {
      event.preventDefault();

      const key = this.dataset.key;
      if (!key) {
        console.error('CartRemoveButton missing data-key');
        return;
      }

      const cartItems = this.closest('cart-items') || this.closest('cart-drawer-items');
      if (!cartItems) {
        console.error('No cart-items element found');
        return;
      }

      cartItems.removeByKey(key);
    });
  }
}

customElements.define('cart-remove-button', CartRemoveButton);

class CartItems extends HTMLElement {
  constructor() {
    super();

    this.lineItemStatusElement =
      document.getElementById('shopping-cart-line-item-status') || document.getElementById('CartDrawer-LineItemStatus');

    const debouncedOnChange = debounce((event) => {
      this.onChange(event);
    }, ON_CHANGE_DEBOUNCE_TIMER);

    this.addEventListener('change', debouncedOnChange.bind(this));
  }

  cartUpdateUnsubscriber = undefined;

  connectedCallback() {
    this.cartUpdateUnsubscriber = subscribe(PUB_SUB_EVENTS.cartUpdate, (event) => {
      if (event.source === 'cart-items') return;
      this.onCartUpdate();
    });
  }

  disconnectedCallback() {
    if (this.cartUpdateUnsubscriber) this.cartUpdateUnsubscriber();
  }

  resetQuantityInput(id) {
    const input = this.querySelector(`#Quantity-${id}`);
    input.value = input.getAttribute('value');
    this.isEnterPressed = false;
  }

  setValidity(event, index, message) {
    event.target.setCustomValidity(message);
    event.target.reportValidity();
    this.resetQuantityInput(index);
    event.target.select();
  }

  validateQuantity(event) {
    const inputValue = parseInt(event.target.value);
    const index = event.target.dataset.index;
    let message = '';

    if (inputValue < event.target.dataset.min) {
      message = window.quickOrderListStrings.min_error.replace('[min]', event.target.dataset.min);
    } else if (inputValue > parseInt(event.target.max)) {
      message = window.quickOrderListStrings.max_error.replace('[max]', event.target.max);
    } else if (inputValue % parseInt(event.target.step) !== 0) {
      message = window.quickOrderListStrings.step_error.replace('[step]', event.target.step);
    }

    if (message) {
      this.setValidity(event, index, message);
    } else {
      event.target.setCustomValidity('');
      event.target.reportValidity();

      this.updateQuantityByIndex(
        index,
        inputValue,
        document.activeElement.getAttribute('name'),
        event.target.dataset.quantityVariantId
      );
    }
  }

  onChange(event) {
    this.validateQuantity(event);
  }

  /* -------------------------------------------------
     ✅ UPDATED: QUANTITY UPDATE (line INDEX)
  ---------------------------------------------------*/
  updateQuantityByIndex(line, quantity, name, variantId) {
    this.enableLoading(line);

    const body = JSON.stringify({
      line,
      quantity,
      sections: this.getSectionsToRender().map((section) => section.section),
      sections_url: window.location.pathname,
    });

    fetch(`${routes.cart_change_url}`, { ...fetchConfig(), body })
      .then((response) => response.text())
      .then((stateText) => {
        const parsedState = JSON.parse(stateText);

        this.refreshSections(parsedState);

        publish(PUB_SUB_EVENTS.cartUpdate, {
          source: 'cart-items',
          cartData: parsedState,
          variantId,
        });
      })
      .catch((e) => console.error(e))
      .finally(() => this.disableLoading(line));
  }

  /* -------------------------------------------------
     ✅ NEW: REMOVE BY LINE-ITEM KEY
  ---------------------------------------------------*/
  removeByKey(key) {
    const body = JSON.stringify({
      id: key,
      quantity: 0,
      sections: this.getSectionsToRender().map((s) => s.section),
      sections_url: window.location.pathname,
    });

    fetch(routes.cart_change_url, { ...fetchConfig(), body })
      .then((res) => res.text())
      .then((stateText) => {
        const parsedState = JSON.parse(stateText);
        this.refreshSections(parsedState);

        publish(PUB_SUB_EVENTS.cartUpdate, {
          source: 'cart-items',
          cartData: parsedState,
        });
      })
      .catch(console.error);
  }

  /* -------------------------------------------------
     ✅ Your refresh logic preserved 100%
  ---------------------------------------------------*/
  onCartUpdate() {
    if (this.tagName === 'CART-DRAWER-ITEMS') {
      fetch(`${routes.cart_url}?section_id=cart-drawer`)
        .then((response) => response.text())
        .then((responseText) => {
          const html = new DOMParser().parseFromString(responseText, 'text/html');
          const selectors = ['cart-drawer-items', '.cart-drawer__footer'];
          for (const selector of selectors) {
            const targetElement = document.querySelector(selector);
            const sourceElement = html.querySelector(selector);
            if (targetElement && sourceElement) {
              targetElement.replaceWith(sourceElement);
            }
          }
        })
        .catch(console.error);
    } else {
      fetch(`${routes.cart_url}?section_id=main-cart-items`)
        .then((response) => response.text())
        .then((responseText) => {
          const html = new DOMParser().parseFromString(responseText, 'text/html');
          const sourceQty = html.querySelector('cart-items');
          this.innerHTML = sourceQty.innerHTML;
        })
        .catch(console.error);
    }
  }

  /* -------------------------------------------------
     ✅ Your original section refresh preserved
  ---------------------------------------------------*/
  refreshSections(parsedState) {
    this.classList.toggle('is-empty', parsedState.item_count === 0);

    const cartDrawerWrapper = document.querySelector('cart-drawer');
    if (cartDrawerWrapper) {
      cartDrawerWrapper.classList.toggle('is-empty', parsedState.item_count === 0);
    }

    this.getSectionsToRender().forEach((section) => {
      const container = document.getElementById(section.id);
      if (!container) return;

      const html = parsedState.sections?.[section.section];
      if (!html) return;

      const replaced = container.querySelector(section.selector) || container;
      replaced.innerHTML = this.getSectionInnerHTML(html, section.selector);
    });
  }

  getSectionsToRender() {
    return [
      {
        id: 'main-cart-items',
        section: document.getElementById('main-cart-items')?.dataset.id,
        selector: '.js-contents',
      },
      {
        id: 'main-cart-footer',
        section: document.getElementById('main-cart-footer')?.dataset.id,
        selector: '.js-contents',
      },
    ];
  }

  getSectionInnerHTML(html, selector) {
    return new DOMParser().parseFromString(html, 'text/html').querySelector(selector).innerHTML;
  }

  enableLoading(line) {
    const mainCartItems = document.getElementById('main-cart-items') || document.getElementById('CartDrawer-CartItems');
    mainCartItems.classList.add('cart__items--disabled');

    this.lineItemStatusElement?.setAttribute('aria-hidden', false);
  }

  disableLoading(line) {
    const mainCartItems = document.getElementById('main-cart-items') || document.getElementById('CartDrawer-CartItems');
    mainCartItems.classList.remove('cart__items--disabled');

    this.lineItemStatusElement?.setAttribute('aria-hidden', true);
  }
}

customElements.define('cart-items', CartItems);

/* -------------------------------------------------
   ✅ Your Cart Note script unchanged
---------------------------------------------------*/
if (!customElements.get('cart-note')) {
  customElements.define(
    'cart-note',
    class CartNote extends HTMLElement {
      constructor() {
        super();

        this.addEventListener(
          'input',
          debounce((event) => {
            const body = JSON.stringify({ note: event.target.value });
            fetch(`${routes.cart_update_url}`, { ...fetchConfig(), body });
          }, ON_CHANGE_DEBOUNCE_TIMER)
        );
      }
    }
  );
}
