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

    this.addEventListener('change', (event) => {
      const form = document.querySelector('[data-film-printing-form]');
      if ((window.BFLPrintJob?.forForm(form) || window.BFLPrintJob?.forCart?.())?.mode === 'prepared-unit-v3') {
        this.onChange(event);
      } else {
        debouncedOnChange(event);
      }
    });
  }

  cartUpdateUnsubscriber = undefined;

  connectedCallback() {
    this.cartUpdateUnsubscriber = subscribe(PUB_SUB_EVENTS.cartUpdate, (event) => {
      if (event.source !== 'cart-guard') {
        this.validateReturnShipping(event.cartData);
        this.validateSizeShipping();
      }

      if (event.source === 'cart-items') return;
      this.onCartUpdate();
    });

    this.validateSizeShipping();
  }

  validateReturnShipping(cartInput) {
    if (!window.globalReturnShippingVariantId) return;

    // Always fetch fresh cart to be 100% sure of state (avoids race conditions with event payloads)
    // Add cache buster to prevent stale reads
    fetch(window.routes.cart_url + '.js?t=' + Date.now())
      .then((res) => res.json())
      .then((cart) => {
        this._runGuardLogic(cart);
      })
      .catch(console.error);
  }

  _getLineProp(item, name) {
    const props = item?.properties;
    if (!props) return '';
    if (Array.isArray(props)) {
      const found = props.find((prop) => String(prop.name || '') === name);
      return found ? String(found.value || '') : '';
    }
    return props[name] != null ? String(props[name]) : '';
  }

  _isSizeShippingItem(item) {
    const handle = item.handle || item.product_handle || '';
    if (handle === 'print-shipping' || handle === 'print-size-shipping-items') return true;
    return this._getLineProp(item, '_role') === 'shipping_size';
  }

  _isFilmPrintItem(item) {
    const handle = item.handle || item.product_handle || '';
    return handle === 'film-printing' || handle === 'film-service';
  }

  validateSizeShipping() {
    if (window.__bflSizeShippingGuardRunning) return;
    window.__bflSizeShippingGuardRunning = true;

    const cartUrl = (window.routes && window.routes.cart_url) || '/cart';
    fetch(`${cartUrl}.js?t=${Date.now()}`)
      .then((res) => res.json())
      .then((cart) => {
        const updates = this._collectSizeShippingOrphans(cart);
        if (!updates) return null;
        const updateUrl = (window.routes && window.routes.cart_update_url) || '/cart/update.js';
        return fetch(updateUrl, {
          ...fetchConfig(),
          body: JSON.stringify({ updates }),
        }).then((res) => res.json());
      })
      .then((data) => {
        if (data) this.refreshCart(data);
      })
      .catch(console.error)
      .finally(() => {
        window.__bflSizeShippingGuardRunning = false;
      });
  }

  _collectSizeShippingOrphans(cart) {
    if (!cart || !cart.items) return null;
    const printItems = cart.items.filter((item) => this._isFilmPrintItem(item));
    const printTimestamps = new Set(
      printItems.map((item) => String(this._getLineProp(item, '_timestamp') || '')).filter(Boolean)
    );

    const updates = {};
    let hasUpdates = false;
    cart.items.forEach((item) => {
      if (!this._isSizeShippingItem(item)) return;
      if (printItems.length === 0) {
        updates[item.key] = 0;
        hasUpdates = true;
        return;
      }
      const parentTs = String(this._getLineProp(item, '_parent_timestamp') || '');
      if (parentTs && !printTimestamps.has(parentTs)) {
        updates[item.key] = 0;
        hasUpdates = true;
      }
    });
    return hasUpdates ? updates : null;
  }

  _runGuardLogic(cart) {
    if (!cart || !cart.items) return;
    const shippingId = window.globalReturnShippingVariantId;

    // Helper to check properties (handles Object or Array format)
    const hasShippingProperty = (item) => {
      const props = item.properties;
      if (!props) return false;

      // Handle Array format: [{name: 'K', value: 'V'}]
      if (Array.isArray(props)) {
        return props.some((p) => {
          const k = String(p.name || '');
          // Check for robust hidden flag first
          if (k === '_return_shipping_required' && String(p.value) === 'true') return true;
          // Fallback to legacy string match (case-insensitive)
          const kLower = k.toLowerCase();
          const vLower = String(p.value || '')
            .trim()
            .toLowerCase();
          return kLower.includes('negatives shipped back') && vLower === 'yes';
        });
      }

      // Handle Object format: { 'K': 'V' }
      // Check for robust hidden flag first
      if (props['_return_shipping_required'] === 'true') return true;

      // Fallback to legacy string match
      return Object.keys(props).some((k) => {
        const key = String(k).toLowerCase();
        const val = String(props[k]).trim().toLowerCase();
        return key.includes('negatives shipped back') && val === 'yes';
      });
    };

    const needsShipping = cart.items.some((item) => hasShippingProperty(item));
    const shippingItem = cart.items.find((item) => item.id === shippingId || item.variant_id === shippingId);

    // console.log('Cart Guard Check:', { needsShipping, hasShippingItem: !!shippingItem });

    let updates = {};
    let hasUpdates = false;

    if (needsShipping) {
      if (!shippingItem) {
        // MISSING: Add it
        fetch(window.routes.cart_add_url, {
          ...fetchConfig(),
          body: JSON.stringify({
            items: [
              {
                id: shippingId,
                quantity: 1,
                properties: { _role: 'return_shipping' },
              },
            ],
          }),
        })
          .then((res) => res.json())
          .then(() => this.refreshCart()) // No args = fetch fresh
          .catch(console.error);
        return; // Exit to avoid conflict
      } else if (shippingItem.quantity !== 1) {
        // WRONG QTY: Fix it
        // console.log('Guard: Correcting shipping quantity...');
        updates[shippingItem.key] = 1;
        hasUpdates = true;
      }
    } else {
      if (shippingItem) {
        // ORPHANED: Remove it
        // console.log('Guard: Removing orphaned shipping item...');
        updates[shippingItem.key] = 0;
        hasUpdates = true;
      }
    }

    if (hasUpdates) {
      fetch(window.routes.cart_update_url, {
        ...fetchConfig(),
        body: JSON.stringify({ updates }),
      })
        .then((res) => res.json())
        .then((data) => this.refreshCart(data))
        .catch(console.error);
    }
  }

  refreshCart(parsedState) {
    // Helper to sync everything up after an auto-correction
    // If we have state, publish it. If not, fetch it.
    if (parsedState) {
      publish(PUB_SUB_EVENTS.cartUpdate, {
        source: 'cart-guard',
        cartData: parsedState,
      });
    } else {
      fetch(window.routes.cart_url + '.js')
        .then((r) => r.json())
        .then((cart) => {
          publish(PUB_SUB_EVENTS.cartUpdate, {
            source: 'cart-guard',
            cartData: cart,
          });
        });
    }
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
  async changeOwnedCart(selector, quantity) {
    const form = document.querySelector('[data-film-printing-form]');
    const flow = window.BFLPrintJob?.forForm(form) || window.BFLPrintJob?.forCart?.();
    if (typeof flow?.changeCart !== 'function') {
      // Closed test items remain removable through Shopify's ordinary zero-
      // quantity path. Increases still require the authenticated print adapter.
      if (quantity === 0 || !this.querySelector?.('.cart-item[data-bfl-flow="f05"]')) return false;
      const message = 'This test cart is not ready. Return to the Film Printing test page before changing these items.';
      for (const id of ['CartDrawer-CartErrors', 'cart-errors']) {
        const error = document.getElementById(id);if (error) error.textContent = message;
      }
      return true;
    }
    const cartUrl = window.routes?.cart_url || '/cart';
    const drawer = this.closest?.('cart-drawer') || document.querySelector('cart-drawer');
    if (drawer?.getAttribute?.('aria-busy') === 'true' || drawer?.classList?.contains('update-failed')) return true;
    drawer?.setPending?.(true);
    let handled = false;
    let failed = false;
    let message = '';
    const renderedItem = Array.from(this.querySelectorAll?.('.cart-item[data-bfl-flow]') || []).find(row => selector.key
      ? row.querySelector('cart-remove-button[data-key]')?.dataset.key === selector.key
      : row.querySelector('input[name="updates[]"][data-index]')?.dataset.index === String(selector.line));
    const ordinary = renderedItem?.dataset.bflFlow === '';
    const renderedKey = renderedItem?.querySelector('cart-remove-button[data-key]')?.dataset.key;
    const quantityInput = renderedItem?.querySelector('input[name="updates[]"][data-index]');
    const confirmedQuantity = quantityInput?.getAttribute?.('value');
    try {
      flow.assertCurrent?.();
      await flow.ready;
      // A retained print adapter must not claim an ordinary line added later.
      // Match the actual control, and require its explicit ordinary-line marker.
      if (ordinary) return false;
      let item;
      if (flow.mode === 'prepared-unit-v3') {
        // Ordinary native edits can shift line indexes before this adapter
        // refreshes. Resolve the protected row by its actual rendered key.
        item = flow.resolveCartItem(renderedKey ? { key: renderedKey } : selector);
        if (!item) throw new Error('Cart unavailable');
      } else {
        const response = await fetch(`${cartUrl}.js`, { cache: 'no-store' });
        if (!response.ok) throw new Error('Cart unavailable');
        const before = await response.json();
        item = selector.key ? before.items.find(row => row.key === selector.key) : before.items[Number(selector.line) - 1];
      }
      if (item?.properties?._bfl_flow !== 'f05') return false;
      handled = true;
      this.enableLoading(selector.line || 1);
      const result = await flow.changeCart({ job: item.properties._bfl_job, quantity });
      if (!result?.accepted) throw new Error('Cart unavailable');
      await this.refreshOwnedCart(result.cart, result.render);
      return true;
    } catch (cause) {
      // A failed accepted-cart read cannot own a separately marked ordinary
      // line. Dispatched or otherwise uncertain writes still block both paths.
      if (ordinary && !cause?.cartUncertain &&
          (cause?.acceptedCartReadOnly === true || cause?.reason === 'CHECKOUT_RESUME_REJECTED')) return false;
      // An accepted restoration cannot dispatch a native write. If that read
      // fails, only the exact rendered protected key may use native removal.
      const acceptedReadOnly = flow.mode === 'prepared-unit-v3' && !handled &&
        !cause?.cartUncertain && cause?.acceptedCartReadOnly === true && renderedItem?.dataset.bflFlow === 'f05' &&
        typeof renderedKey === 'string' && renderedKey.length > 0;
      if (acceptedReadOnly && quantity === 0 && selector.key === renderedKey) return { nativeRemoveKey: renderedKey };
      // Dispatched or otherwise uncertain writes never fall through.
      const closed = flow.mode === 'prepared-unit-v3' && !cause?.cartUncertain &&
        ['RESOURCE_EXPIRED', 'PREPARED_EXPIRED', 'ENGINEERING_EXPIRED', 'RESOURCE_REJECTED', 'DIAGNOSTIC_CLOSED', 'CUSTOMER_RESOURCES_CLOSED'].includes(cause?.reason ?? cause?.message);
      if (closed && quantity === 0) return false;
      // A rejected restoration has not changed the cart. Keep its exact rendered
      // quantity instead of leaving the unsubmitted edit visible. Do not claim
      // a rollback after dispatch, uncertainty, or a newer input/render change.
      if (!handled && !cause?.cartUncertain && (closed || acceptedReadOnly) &&
          renderedItem?.dataset.bflFlow === 'f05' && /^[1-9]\d*$/.test(confirmedQuantity ?? '') &&
          quantityInput.value === String(quantity) && quantityInput.getAttribute('value') === confirmedQuantity) {
        quantityInput.value = confirmedQuantity;
      }
      failed = !closed && !acceptedReadOnly;
      message = flow.errorMessage?.(cause, { cart: true }) || 'The cart could not be confirmed. Please contact us before trying again.';
      // Unknown outcomes never fall through to a second native mutation.
      for (const id of ['CartDrawer-CartErrors', 'cart-errors']) {
        const error = document.getElementById(id);if (error) error.textContent = message;
      }
      return true;
    } finally {
      this.disableLoading(selector.line || 1);
      drawer?.setPending?.(false, { failed, message });
      if (!failed && message) {
        for (const id of ['CartDrawer-CartErrors', 'cart-errors']) {
          const error = document.getElementById(id);if (error) error.textContent = message;
        }
      }
    }
  }

  async refreshOwnedCart(acceptedCart, render) {
    const cartUrl = window.routes?.cart_url || '/cart';
    const renderedSections = this.getSectionsToRender().map(section =>
      section.id === 'CartDrawer' ? { ...section, selector: '#CartDrawer' } : section);
    const sectionIds = renderedSections.map(section => section.section).filter(Boolean);
    let current, sections;
    if (render) {
      current = render.ajax; sections = render.sections;
    } else {
      const [currentResponse, sectionsResponse] = await Promise.all([
        fetch(`${cartUrl}.js`, { cache: 'no-store' }),
        fetch(`${cartUrl}?sections=${encodeURIComponent(sectionIds.join(','))}`, { cache: 'no-store' }),
      ]);
      if (!currentResponse.ok || !sectionsResponse.ok) throw new Error('Cart unavailable');
      [current, sections] = await Promise.all([currentResponse.json(), sectionsResponse.json()]);
    }
    if (current.items.length !== acceptedCart.items.length || !acceptedCart.items.every(line =>
      current.items.some(row => (line.properties._bfl_job ? row.properties?._bfl_job === line.properties._bfl_job :
        typeof line.key === 'string' && row.key === line.key && String(row.variant_id) === line.variant_id &&
        Object.keys(row.properties || {}).length === Object.keys(line.properties).length &&
        Object.entries(line.properties).every(([key, value]) => row.properties?.[key] === value)) &&
        row.quantity === line.quantity && row.final_line_price === line.subtotal_cents)) ||
        current.total_price !== acceptedCart.items.reduce((sum, line) => sum + line.subtotal_cents, 0)) throw new Error('Cart changed');

    if (render) {
      const html = sections?.['cart-drawer'];
      if (typeof html !== 'string') throw new Error('Cart sections unavailable');
      const parsed = new DOMParser().parseFromString(html, 'text/html');
      const removals = [...parsed.querySelectorAll('cart-remove-button[data-key]')];
      if (removals.length !== current.items.length || new Set(removals.map(node => node.dataset.key)).size !== current.items.length ||
          !current.items.every(row => removals.some(node => node.dataset.key === row.key &&
            Number(node.closest('.cart-item')?.dataset.finalLinePrice) === row.final_line_price &&
            Number(node.closest('.cart-item')?.querySelector('input[name="updates[]"]')?.value) === row.quantity)) ||
          (current.items.length && Number(parsed.querySelector('[data-cart-total]')?.dataset.cartTotal) !== current.total_price)) throw new Error('Cart sections changed');
    }
    current.sections = sections;
    this.refreshSections(current, renderedSections);
    publish(PUB_SUB_EVENTS.cartUpdate, { source: 'cart-items', cartData: current });
  }

  async updateQuantityByIndex(line, quantity, name, variantId) {
    if (await this.changeOwnedCart({ line }, quantity)) return;
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
  async removeByKey(key) {
    const owned = await this.changeOwnedCart({ key }, 0);
    const readOnlyRemoval = owned?.nativeRemoveKey === key;
    if (owned && !readOnlyRemoval) return;
    if (this.removing) return;
    this.removing = true;
    const drawer = this.closest?.('cart-drawer') || document.querySelector('cart-drawer');
    if (readOnlyRemoval) drawer?.setPending?.(true);
    let dispatched = false, uncertain = false, failureMessage = '';
    const sections = this.getSectionsToRender().map((s) => s.section).filter(Boolean);
    const sectionsUrl = window.location.pathname;
    const cartUrl = (window.routes && window.routes.cart_url) || '/cart';
    const updateUrl = (window.routes && window.routes.cart_update_url) || '/cart/update.js';
    const changeUrl = (window.routes && window.routes.cart_change_url) || routes.cart_change_url;

    const publishRemoved = (parsedState) => {
      this.refreshSections(parsedState);
      publish(PUB_SUB_EVENTS.cartUpdate, {
        source: 'cart-items',
        cartData: parsedState,
      });
    };

    return fetch(`${cartUrl}.js?t=${Date.now()}`)
      .then(async (res) => {
        const cart = await res.json();
        if (!res.ok || !Array.isArray(cart.items)) throw new Error('Unexpected error. Please contact us.');
        return cart;
      })
      .then(async (cart) => {
        const updates = { [key]: 0 };
        const items = cart.items || [];
        const removed = items.find((item) => item.key === key);
        if (!removed) {
          // Refresh stale rows without dispatching another removal.
          if (sections.length) {
            const response = await fetch(`${cartUrl}?sections=${encodeURIComponent(sections.join(','))}`, { cache: 'no-store' });
            const html = await response.json();
            if (!response.ok || sections.some(section => typeof html?.[section] !== 'string')) throw new Error('Cart sections unavailable');
            cart.sections = html;
          }
          return cart;
        }
        if (readOnlyRemoval && this._getLineProp(removed, '_bfl_flow') !== 'f05') throw new Error('The cart changed. Reload it before removing this item.');
        const remainingPrints = items.filter((item) => item.key !== key && this._isFilmPrintItem(item));

        if (!readOnlyRemoval && removed && this._isFilmPrintItem(removed)) {
          const parentTs = String(this._getLineProp(removed, '_timestamp') || '');
          items.forEach((item) => {
            if (item.key === key || !this._isSizeShippingItem(item)) return;
            const childTs = String(this._getLineProp(item, '_parent_timestamp') || '');
            if (remainingPrints.length === 0 || (parentTs && childTs && childTs === parentTs)) {
              updates[item.key] = 0;
            }
          });
        }

        if (Object.keys(updates).length === 1) {
          const body = JSON.stringify({
            id: key,
            quantity: 0,
            sections,
            sections_url: sectionsUrl,
          });
          dispatched = true;
          return fetch(changeUrl, { ...fetchConfig(), body }).then(async (res) => {
            const state = await res.json();
            if (!res.ok || state.errors || !Array.isArray(state.items)) throw new Error(typeof state.description === 'string' ? state.description : 'Unexpected error. Please contact us.');
            return state;
          });
        }

        const body = JSON.stringify({
          updates,
          sections,
          sections_url: sectionsUrl,
        });
        dispatched = true;
        return fetch(updateUrl, { ...fetchConfig(), body }).then(async (res) => {
          const state = await res.json();
          if (!res.ok || state.errors || !Array.isArray(state.items)) throw new Error(typeof state.description === 'string' ? state.description : 'Unexpected error. Please contact us.');
          return state;
        });
      })
      .then((state) => {
        publishRemoved(state);
      })
      .catch((error) => {
        uncertain = readOnlyRemoval && dispatched;failureMessage = error.message;
        ['CartDrawer-CartErrors', 'cart-errors'].forEach((id) => {
          const target = document.getElementById(id);
          if (target) target.textContent = error.message;
        });
      })
      .finally(() => {
        this.removing = false;
        if (readOnlyRemoval) {
          drawer?.setPending?.(false, { failed: uncertain, message: failureMessage });
          if (failureMessage) for (const id of ['CartDrawer-CartErrors', 'cart-errors']) {
            const error = document.getElementById(id);if (error) error.textContent = failureMessage;
          }
        }
      });
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
  refreshSections(parsedState, sections = this.getSectionsToRender()) {
    this.classList.toggle('is-empty', parsedState.item_count === 0);
    const cartLink = document.getElementById('cart-icon-bubble');
    const badge = cartLink?.querySelector('.cart-button__number');
    if (badge) badge.textContent = String(parsedState.item_count);
    cartLink?.setAttribute('aria-label', `Shopping cart with ${parsedState.item_count} item${parsedState.item_count === 1 ? '' : 's'}`);

    const cartDrawerWrapper = document.querySelector('cart-drawer');
    if (cartDrawerWrapper) {
      cartDrawerWrapper.classList.toggle('is-empty', parsedState.item_count === 0);
    }

    sections.forEach((section) => {
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
      {
        id: 'CartDrawer',
        section: 'cart-drawer',
        selector: '#CartDrawer',
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
