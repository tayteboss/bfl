document.addEventListener('DOMContentLoaded', () => {
  const form = document.querySelector('#film-service-form');
  if (!form) return;
  // Disable native constraint validation so our custom validator handles errors/scroll
  try {
    form.setAttribute('novalidate', 'novalidate');
  } catch (_) {}

  const totalDisplay = document.querySelector('#film-total-display');
  const osList = document.querySelector('[data-os-list]');
  const osToggle = document.querySelector('[data-os-toggle]');
  const osDetails = document.querySelector('[data-os-details]');
  const orderSummary = document.querySelector('[data-order-summary]');
  const qtyInput = form.querySelector('input[name="quantity"]');
  const qtyMinusBtn = form.querySelector('.quantity-btn--minus');
  const qtyPlusBtn = form.querySelector('.quantity-btn--plus');
  // Feature flag: show per-option prices in the Order Summary
  const OS_SHOW_PRICES = true;
  const basePrice = Number(document.querySelector('#base-price').dataset.base);
  const variantInput = form.querySelector('input[name="id"]');
  const submitBtn = form.querySelector('button[type="submit"]');
  const cartDrawer = document.querySelector('cart-drawer');
  const serviceRadios = form.querySelectorAll('input[name="service"]');
  const serviceBlocks = form.querySelectorAll('.service-groups-wrapper');
  let total = basePrice;

  const getQuantity = () =>
    Math.max(1, parseInt((form.querySelector('input[name="quantity"]') || {}).value || '1', 10) || 1);

  // Wire up quantity +/- buttons for this form (not handled by global <quantity-input> component)
  const syncQuantity = (delta) => {
    if (!qtyInput) return;
    const current = Math.max(1, parseInt(qtyInput.value || '1', 10) || 1);
    const next = Math.max(1, current + delta);
    if (next === current) return;
    qtyInput.value = String(next);
    // Trigger change so totals & order summary update
    qtyInput.dispatchEvent(new Event('change', { bubbles: true }));
  };

  if (qtyMinusBtn) {
    qtyMinusBtn.addEventListener('click', (event) => {
      event.preventDefault();
      syncQuantity(-1);
    });
  }

  if (qtyPlusBtn) {
    qtyPlusBtn.addEventListener('click', (event) => {
      event.preventDefault();
      syncQuantity(1);
    });
  }

  // Hide all service groups initially
  serviceBlocks.forEach((block) => (block.style.display = 'none'));

  // --- Visibility helpers for validation ---
  const isVisible = (el) => {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    return !!(el.offsetParent || style.position === 'fixed');
  };

  const getVisibleFieldsets = () =>
    Array.from(form.querySelectorAll('fieldset.rolls-form-card')).filter((fs) => isVisible(fs));

  const getVisibleRadiosInFieldset = (fs) =>
    Array.from(fs.querySelectorAll('input[type="radio"]')).filter((r) => {
      const carrier = r.closest('label') || r;
      return isVisible(carrier);
    });

  // --- Delivery info visibility (Mail In vs Drop Off copy) ---
  const mailInInfo = form.querySelector('[data-delivery-info="mail-in"]');
  const dropOffInfo = form.querySelector('[data-delivery-info="drop-off"]');
  const deliveryMap = form.querySelector('.rolls-form-card-content__drop-off-map');
  const deliveryDivider = form.querySelector('[data-delivery-divider]');

  const refreshDropOffMap = (opts) => {
    const options = opts || {};
    try {
      if (window.BellowsDropOffMap) {
        if (typeof window.BellowsDropOffMap.invalidateAll === 'function') {
          window.BellowsDropOffMap.invalidateAll();
        }
        // Allow callers to skip resetting the view so we don't blow away a user-focused zoom
        if (!options.skipReset && typeof window.BellowsDropOffMap.resetAll === 'function') {
          window.BellowsDropOffMap.resetAll();
        }
      }
    } catch (_e) {}
  };

  const updateDeliveryInfoVisibility = () => {
    if (!mailInInfo || !dropOffInfo) return;
    const selected = form.querySelector('input[name="delivery"]:checked');

    if (!selected) {
      // No delivery selected yet: show both text blocks and the map, show divider
      mailInInfo.style.display = '';
      dropOffInfo.style.display = '';
      if (deliveryMap) deliveryMap.style.display = '';
      if (deliveryDivider) deliveryDivider.style.display = '';
      refreshDropOffMap();
      return;
    }

    const val = (selected.value || '').toString().trim().toLowerCase();

    if (val === 'mail in' || val === 'mail-in') {
      // Mail In only
      mailInInfo.style.display = '';
      dropOffInfo.style.display = 'none';
      if (deliveryMap) deliveryMap.style.display = 'none';
      if (deliveryDivider) deliveryDivider.style.display = 'none';
    } else if (val === 'drop off' || val === 'drop-off') {
      // Drop Off only + map
      mailInInfo.style.display = 'none';
      dropOffInfo.style.display = '';
      if (deliveryMap) deliveryMap.style.display = '';
      if (deliveryDivider) deliveryDivider.style.display = 'none';
      // Only invalidate size so we keep any zoom/location chosen by the user (e.g. via city selection)
      refreshDropOffMap({ skipReset: true });
    } else {
      // Fallback: both visible and map visible
      mailInInfo.style.display = '';
      dropOffInfo.style.display = '';
      if (deliveryMap) deliveryMap.style.display = '';
      if (deliveryDivider) deliveryDivider.style.display = '';
      refreshDropOffMap();
    }
  };

  const scrollToFieldset = (fs, offset = 100) => {
    if (!fs) return;
    const rect = fs.getBoundingClientRect();
    const targetTop = Math.max(0, rect.top + window.scrollY - offset);
    window.scrollTo({ top: targetTop, behavior: 'smooth' });
  };

  const scrollToNextVisibleFieldset = (currentFs, offset = 100) => {
    if (!currentFs) return;
    const fieldsets = Array.from(form.querySelectorAll('fieldset.rolls-form-card'));
    const idx = fieldsets.indexOf(currentFs);
    if (idx === -1) return;
    for (let i = idx + 1; i < fieldsets.length; i += 1) {
      const candidate = fieldsets[i];
      if (isVisible(candidate)) {
        scrollToFieldset(candidate, offset);
        break;
      }
    }
  };

  // Auto-select any option marked as data-default-option="true" when a fieldset becomes active,
  // but do it per radio "name" so multiple logical groups inside one fieldset (e.g. Add Ons)
  // each get their own default.
  const applyDefaultsInContainer = (container) => {
    if (!container) return;
    const fieldsets = container.querySelectorAll('fieldset.rolls-form-card');
    fieldsets.forEach((fs) => {
      if (!isVisible(fs)) return;
      const visibleRadios = getVisibleRadiosInFieldset(fs);
      if (!visibleRadios.length) return;

      // Group by radio name so each logical group can get its own default
      const groupsByName = new Map();
      visibleRadios.forEach((r) => {
        const name = r.name || '__anon__';
        if (!groupsByName.has(name)) groupsByName.set(name, []);
        groupsByName.get(name).push(r);
      });

      groupsByName.forEach((groupRadios) => {
        if (!groupRadios.length) return;
        const anyChecked = groupRadios.some((r) => r.checked);
        if (anyChecked) return;
        const defaultRadio = groupRadios.find((r) => r.dataset.defaultOption === 'true');
        if (!defaultRadio) return;
        defaultRadio.checked = true;
        // Fire change so pricing / conditions update
        defaultRadio.dispatchEvent(new Event('change', { bubbles: true }));
      });
    });
  };

  const clearErrorsOnHidden = () => {
    form.querySelectorAll('fieldset.rolls-form-card').forEach((fs) => {
      if (!isVisible(fs)) fs.classList.remove('rolls-form-card--error');
    });
  };

  const validateOpenFields = () => {
    const errors = [];
    getVisibleFieldsets().forEach((fs) => {
      const visibleRadios = getVisibleRadiosInFieldset(fs);
      if (visibleRadios.length === 0) {
        fs.classList.remove('rolls-form-card--error');
        return;
      }
      const anyChecked = visibleRadios.some((r) => r.checked);
      if (!anyChecked) {
        fs.classList.add('rolls-form-card--error');
        errors.push(fs);
      } else {
        fs.classList.remove('rolls-form-card--error');
      }
    });
    return { errors };
  };

  // Utility: normalize keys/values so JSON keys like "Film Format", "film_format" match radio.name "film-format"
  const normKey = (s) =>
    (s || '')
      .toString()
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '-') // spaces -> hyphen
      .replace(/_+/g, '-') // underscores -> hyphen
      .replace(/-+/g, '-'); // normalize multiple hyphens to single hyphen

  const normVal = (s) => (s || '').toString().trim().toLowerCase();

  // Helper to get value from selected map with multiple key variations
  const getSelectedValue = (key, selected) => {
    // Try original key (lowercased) first
    const originalLower = (key || '').toString().trim().toLowerCase();
    if (selected[originalLower] !== undefined) return selected[originalLower];

    // Try normalized key
    const normalized = normKey(key);
    if (selected[normalized] !== undefined) return selected[normalized];

    // Try with underscores
    const withUnderscores = normalized.replace(/-/g, '_');
    if (selected[withUnderscores] !== undefined) return selected[withUnderscores];

    // Try with multiple hyphens (for cases like "Add Ons - Contact Sheet" -> "add-ons---contact-sheet")
    const withMultiHyphens = originalLower.replace(/\s+/g, '---').replace(/_+/g, '---');
    if (selected[withMultiHyphens] !== undefined) return selected[withMultiHyphens];

    // Try original with spaces replaced by single hyphens
    const withSingleHyphens = originalLower.replace(/\s+/g, '-');
    if (selected[withSingleHyphens] !== undefined) return selected[withSingleHyphens];

    return null;
  };

  // --- Handle service change (show only selected service block) ---
  serviceRadios.forEach((radio) => {
    radio.addEventListener('change', (e) => {
      const selectedService = e.target.value;
      // Hide all service blocks first
      serviceBlocks.forEach((block) => {
        block.style.display = 'none';
      });

      // Show active block for selected service
      const activeBlock = form.querySelector(`.service-groups-wrapper[data-for-service="${selectedService}"]`);
      if (activeBlock) activeBlock.style.display = 'flex';

      // Uncheck radios in all non-active service blocks to prevent stale selections affecting totals
      serviceBlocks.forEach((block) => {
        if (block !== activeBlock) {
          block.querySelectorAll('input[type="radio"]:checked').forEach((input) => {
            input.checked = false;
          });
        }
      });

      // Apply JSON-configured defaults for the now-active service block
      if (activeBlock) {
        applyDefaultsInContainer(activeBlock);
      }

      applyConditions();
    });
  });

  // // Optionally auto-select first service block (keep if you want)
  // if (serviceRadios.length > 0 && !form.querySelector('input[name="service"]:checked')) {
  //   serviceRadios[0].checked = true;
  //   serviceRadios[0].dispatchEvent(new Event('change'));
  // }

  const updateOrderSummaryVisibility = () => {
    if (!orderSummary) return;
    const anyChecked = !!form.querySelector('input[type="radio"]:checked');
    orderSummary.style.display = anyChecked ? '' : 'none';
  };

  // --- UI helpers for Order Summary ---
  const formatMoney = (num) => `$${Number(num || 0).toFixed(2)}`;

  const createRow = (labelText, valueText, priceNum) => {
    if (!osList) return;
    const row = document.createElement('div');
    row.className = 'order-summary__row';

    const dt = document.createElement('dt');
    dt.className = 'order-summary__label type-p';
    dt.textContent = labelText;

    const dd = document.createElement('dd');
    dd.className = 'order-summary__value-wrap';

    const value = document.createElement('span');
    value.className = 'order-summary__value type-p';
    value.textContent = valueText;

    dd.appendChild(value);
    if (OS_SHOW_PRICES && Number(priceNum) > 0) {
      const price = document.createElement('span');
      price.className = 'order-summary__price type-p';
      price.textContent = formatMoney(priceNum);
      dd.appendChild(price);
    }
    row.appendChild(dt);
    row.appendChild(dd);
    osList.appendChild(row);
  };

  const renderSummary = () => {
    if (!osList) return;
    osList.innerHTML = '';

    // Fieldsets in DOM order with checked radios
    form.querySelectorAll('fieldset.rolls-form-card').forEach((fs) => {
      const checked = fs.querySelector('input[type="radio"]:checked');
      if (!checked) return;
      // Skip neutral/base selections in the summary
      if ((checked.value || '').toString().trim().toLowerCase() === 'base') return;
      const heading = fs.querySelector('.rolls-form-card__heading');
      // Prefer explicit short heading attribute when provided
      const attrFromFs = fs.getAttribute('order-summary-heading') || fs.dataset.orderSummaryHeading;
      const attrFromHeading = heading
        ? heading.getAttribute('order-summary-heading') || heading.dataset.orderSummaryHeading
        : null;
      const labelText = (
        attrFromFs ||
        attrFromHeading ||
        (heading ? heading.textContent.trim() : '') ||
        fs.dataset.group ||
        'Option'
      ).trim();
      const labelEl = checked.closest('label');
      const valueEl = labelEl ? labelEl.querySelector('.bubble-option__label') : null;
      // Extract only the option label text, explicitly excluding any .opt-price span
      let valueText = '';
      if (valueEl) {
        const copy = valueEl.cloneNode(true);
        copy.querySelectorAll('.opt-price').forEach((n) => n.remove());
        valueText = (copy.textContent || '').trim();
      } else {
        valueText = (checked.value || '').trim();
      }
      const priceNum = Number(checked.dataset.price || 0);
      createRow(labelText, valueText, priceNum);
    });

    // --- Totals area (consider quantity) ---
    const qty = getQuantity();
    const perRoll = Number(total || 0);
    const grand = perRoll * qty;

    if (qty > 1) {
      createRow('Quantity', String(qty), 0);
      createRow('Subtotal', `${qty} × ${formatMoney(perRoll)}`, grand);
      createRow('Total', formatMoney(grand), 0);
    } else {
      createRow('Total', formatMoney(perRoll), 0);
    }
  };

  // Toggle behavior
  if (osToggle && osDetails) {
    osToggle.addEventListener('click', () => {
      const expanded = osToggle.getAttribute('aria-expanded') === 'true';
      osToggle.setAttribute('aria-expanded', String(!expanded));
      osDetails.hidden = expanded;
      const first = osToggle.querySelector('span:first-child');
      const second = osToggle.querySelector('span:last-child');
      if (first) first.textContent = expanded ? 'Show Details' : 'Hide Details';
      if (second) second.textContent = expanded ? '(+)' : '(-)';
    });
  }

  // --- Total calc ---
  function calculateTotal() {
    total = basePrice;
    form.querySelectorAll('input[type="radio"]:checked').forEach((input) => {
      total += Number(input.dataset.price || 0);
    });
    const qty = getQuantity();
    const displayTotal = qty > 1 ? total * qty : total;
    if (totalDisplay) totalDisplay.textContent = formatMoney(displayTotal);
    renderSummary();
    updateOrderSummaryVisibility();
  }

  // --- Conditions (show-if + price-overrides) with normalized keys ---
  function applyConditions() {
    // Build selected map with multiple aliases for robustness
    const selected = {};
    form.querySelectorAll('input[type="radio"]:checked').forEach((r) => {
      const keyHyphen = normKey(r.name); // e.g., film-format (normalized)
      const keyUnder = keyHyphen.replace(/-/g, '_'); // e.g., film_format
      const keyMultiHyphen = r.name.toLowerCase().replace(/\s+/g, '-'); // original with spaces->hyphens (may have multiple hyphens)
      selected[keyHyphen] = r.value;
      selected[keyUnder] = r.value;
      // Also store the original name variations for matching
      if (keyMultiHyphen !== keyHyphen) {
        selected[keyMultiHyphen] = r.value;
      }
      // Store original name as-is (lowercased)
      selected[r.name.toLowerCase()] = r.value;
    });

    // We no longer disable the submit button live; submission is blocked by custom validation

    form.querySelectorAll('input[type="radio"]').forEach((radio) => {
      const label = radio.closest('label');
      if (!label) return;

      // Safe parse helpers
      const parseJSON = (raw) => {
        if (!raw || raw === 'null' || raw === '{}' || raw === 'undefined') return null;
        try {
          // Decode Shopify's escaped quotes first
          const decoded = raw
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&amp;/g, '&');
          return JSON.parse(decoded);
        } catch (err) {
          console.warn('Invalid JSON in data attribute:', raw);
          return null;
        }
      };

      const showIfRaw = radio.dataset.showIf;
      const priceOverridesRaw = radio.dataset.priceOverrides;
      const defaultIfRaw = radio.dataset.defaultIf;

      const showIf = parseJSON(showIfRaw);
      const priceOverrides = parseJSON(priceOverridesRaw);
      const defaultIf = parseJSON(defaultIfRaw);

      // --- Visibility
      let shouldShow = true;
      if (showIf) {
        // Require ALL show-if groups to match (change to .some if you want "any")
        shouldShow = Object.entries(showIf).every(([k, allowed]) => {
          const sel = getSelectedValue(k, selected);
          if (!Array.isArray(allowed) || !allowed.length) return true;
          const allowedNorm = allowed.map(normVal);
          return sel ? allowedNorm.includes(normVal(sel)) : false;
        });
      }

      // Hide/show option based on show_if; exclusive default_if logic is applied later
      label.style.display = shouldShow ? '' : 'none';
      if (!shouldShow && radio.checked) radio.checked = false;

      // --- Dynamic price override
      let newPrice = Number(radio.dataset.basePrice || radio.dataset.price || 0);
      if (priceOverrides) {
        for (const [k, map] of Object.entries(priceOverrides)) {
          const key = normKey(k);
          const sel = selected[key] || selected[key.replace(/-/g, '_')];
          if (sel != null && map && Object.prototype.hasOwnProperty.call(map, sel)) {
            newPrice = map[sel];
          } else if (sel != null) {
            // Try case-insensitive match on values if needed
            const found = Object.entries(map || {}).find(([valKey]) => normVal(valKey) === normVal(sel));
            if (found) newPrice = found[1];
          }
        }
      }
      radio.dataset.price = newPrice;

      // --- Conditional defaults (default_if in JSON) ---
      // Preserve any static defaults coming from Liquid (`opt.default`)
      const isStaticDefault = radio.dataset.defaultStatic === 'true';
      let matchesDefaultIf = false;

      if (defaultIf) {
        // Require ALL default_if groups to match, same logic as show_if
        matchesDefaultIf = Object.entries(defaultIf).every(([k, allowed]) => {
          const sel = getSelectedValue(k, selected);
          if (!Array.isArray(allowed) || !allowed.length) return true;
          const allowedNorm = allowed.map(normVal);
          return sel ? allowedNorm.includes(normVal(sel)) : false;
        });
      }

      if (matchesDefaultIf) {
        radio.dataset.defaultOption = 'true';
        radio.dataset.defaultIfActive = 'true';
      } else {
        // Clear flag that this option is being forced by default_if
        delete radio.dataset.defaultIfActive;
        // Clear conditional default flag when conditions no longer match
        if (!isStaticDefault) {
          delete radio.dataset.defaultOption;
        }
      }

      // Update visible price text
      const priceEl = label.querySelector('.opt-price');
      if (priceEl) priceEl.textContent = newPrice > 0 ? `$${newPrice}` : 'Free';
    });

    // --- default_if vs default priority per radio group (by name) ---
    // If any option in a group has an active default_if, that option wins over static defaults
    // and becomes the sole checked option in that group (others are unselected but still visible).
    const groupsByName = new Map();
    form.querySelectorAll('input[type="radio"]').forEach((r) => {
      if (!r.name) return;
      if (!groupsByName.has(r.name)) groupsByName.set(r.name, []);
      groupsByName.get(r.name).push(r);
    });

    groupsByName.forEach((radios) => {
      if (!radios.length) return;

      const activeDefaults = radios.filter((r) => r.dataset.defaultIfActive === 'true');
      const primary = activeDefaults[0];

      if (primary) {
        // default_if wins: this option is the only selectable choice in the group
        radios.forEach((r) => {
          const label = r.closest('label');
          if (r === primary) {
            if (label) {
              // Do not force display state here; let show_if control visibility.
              // We only guarantee the primary is enabled and checked.
              label.style.removeProperty('display');
            }
            r.disabled = false;
            r.checked = true;
          } else {
            if (label) label.style.display = 'none';
            r.checked = false;
            r.disabled = true;
            r.dataset.lockedByDefaultIf = 'true';
          }
        });
      } else {
        // No active default_if: restore radios previously locked by default_if
        radios.forEach((r) => {
          if (r.dataset.lockedByDefaultIf === 'true') {
            const label = r.closest('label');
            if (label) label.style.removeProperty('display');
            r.disabled = false;
            delete r.dataset.lockedByDefaultIf;
          }
        });
      }
    });

    // --- Handle section-level show-if (for Add Ons sections) ---
    form.querySelectorAll('[data-show-if]').forEach((section) => {
      // Skip radio buttons (already handled above)
      if (section.tagName === 'INPUT') return;

      const showIfRaw = section.dataset.showIf;
      if (!showIfRaw) return;

      const parseJSON = (raw) => {
        if (!raw || raw === 'null' || raw === '{}' || raw === 'undefined') return null;
        try {
          const decoded = raw
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&amp;/g, '&');
          return JSON.parse(decoded);
        } catch (err) {
          console.warn('Invalid JSON in data attribute:', raw);
          return null;
        }
      };

      const showIf = parseJSON(showIfRaw);
      let shouldShow = true;

      if (showIf) {
        // Require ALL show-if groups to match
        shouldShow = Object.entries(showIf).every(([k, allowed]) => {
          const sel = getSelectedValue(k, selected);
          if (!Array.isArray(allowed) || !allowed.length) return true;
          const allowedNorm = allowed.map(normVal);
          return sel ? allowedNorm.includes(normVal(sel)) : false;
        });
      }

      // Hide/show entire section
      section.style.display = shouldShow ? '' : 'none';

      // Uncheck all radios in section if it becomes hidden
      if (!shouldShow) {
        section.querySelectorAll('input[type="radio"]:checked').forEach((radio) => {
          radio.checked = false;
        });
      }
    });

    // Clear any lingering error states on hidden sections
    clearErrorsOnHidden();

    // Apply defaults (including conditional defaults) to any visible fieldsets
    applyDefaultsInContainer(form);

    calculateTotal();
  }

  // React to any radio change
  form.addEventListener('change', (e) => {
    if (e.target.matches('input[type="radio"]')) {
      applyConditions();

      const fs = e.target.closest('fieldset.rolls-form-card');
      if (fs) {
        const visibleRadios = getVisibleRadiosInFieldset(fs);
        const anyChecked = visibleRadios.some((r) => r.checked);
        if (anyChecked) fs.classList.remove('rolls-form-card--error');
      }

      let handledScroll = false;

      // If Disposable is selected in any Film Format group, scroll to Delivery
      const changedRadio = e.target;
      if (changedRadio.checked) {
        const groupKey = normKey(changedRadio.name);
        const valueNorm = normVal(changedRadio.value);
        if (groupKey === 'film-format' && valueNorm === 'disposable') {
          const quantityFs = form.querySelector('fieldset[data-group="Quantity"]');
          if (quantityFs) {
            scrollToFieldset(quantityFs, 100);
            handledScroll = true;
          }
        }
      }

      // Update delivery info (Mail In vs Drop Off copy) when delivery changes
      if (e.target.name === 'delivery') {
        updateDeliveryInfoVisibility();
      }

      // Auto-scroll to the next visible section for real user interactions,
      // except when we've already handled a special-case scroll (e.g. Disposable).
      if (!handledScroll && e.isTrusted) {
        scrollToNextVisibleFieldset(fs, 100);
      }

      updateOrderSummaryVisibility();
    } else if (e.target.matches('input[name="quantity"]')) {
      // React to quantity changes
      calculateTotal();
    }
  });

  // Match variant by price, using actual carrier ranges (A–E) and handling missing carriers safely
  function findVariantByPrice(priceDollars) {
    const cents = Math.round(priceDollars * 100);

    const carriers = [
      { name: 'A', data: window.carrierA },
      { name: 'B', data: window.carrierB },
      { name: 'C', data: window.carrierC },
      { name: 'D', data: window.carrierD },
      { name: 'E', data: window.carrierE },
    ].filter((c) => Array.isArray(c.data) && c.data.length);

    if (!carriers.length) {
      console.warn('No carrier products configured for film service pricing.');
      return null;
    }

    // Infer min/max ranges for each carrier from its variants
    const withRanges = carriers
      .map((c) => {
        const prices = c.data.map((v) => Number(v.price)).filter((p) => Number.isFinite(p));
        if (!prices.length) return null;
        return {
          ...c,
          min: Math.min(...prices),
          max: Math.max(...prices),
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.min - b.min);

    // Choose the carrier whose range contains this price
    const carrier = withRanges.find((c) => cents >= c.min && cents <= c.max);

    if (!carrier) {
      console.warn('No carrier product covers this price.', {
        priceDollars,
        cents,
        carriers: withRanges.map(({ name, min, max }) => ({ name, min, max })),
      });
      return null;
    }

    const variant = carrier.data.find((v) => Number(v.price) === cents) || null;

    if (!variant) {
      console.warn('No variant found at exact price within selected carrier.', {
        priceDollars,
        cents,
        carrier: carrier.name,
        carrierRange: { min: carrier.min, max: carrier.max },
      });
    }

    return variant;
  }

  function clearFormAndScrollTop() {
    try {
      form.reset();
    } catch (_) {}
    // Hide all service groups after reset
    serviceBlocks.forEach((block) => (block.style.display = 'none'));
    // Reset totals and summary
    if (totalDisplay) totalDisplay.textContent = formatMoney(basePrice);
    if (osList) osList.innerHTML = '';
    applyConditions();
    updateOrderSummaryVisibility();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // Submit
  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    // Validate all currently open/visible fields
    const { errors } = validateOpenFields();
    if (errors.length > 0) {
      // Scroll to first error section (100px above)
      const first = errors
        .map((fs) => ({ fs, top: fs.getBoundingClientRect().top + window.scrollY }))
        .sort((a, b) => a.top - b.top)[0].fs;
      const targetY = Math.max(0, first.getBoundingClientRect().top + window.scrollY - 250);
      window.scrollTo({ top: targetY, behavior: 'smooth' });
      const focusTarget = first.querySelector('input[type="radio"]');
      if (focusTarget) focusTarget.focus({ preventScroll: true });
      return;
    }

    const matchedVariant = findVariantByPrice(total);
    if (!matchedVariant) {
      alert(`No variant found for $${total.toFixed(2)} — please check variant setup.`);
      return;
    }

    variantInput.value = matchedVariant.id;

    const fd = new FormData();
    fd.append('id', matchedVariant.id);
    const selectedQty = Math.max(1, parseInt(qtyInput?.value || '1', 10) || 1);
    fd.append('quantity', selectedQty);

    // --- Append selected options ---
    form.querySelectorAll('fieldset').forEach((fs) => {
      const checked = fs.querySelector('input[type="radio"]:checked');
      if (checked) fd.append(`properties[${fs.dataset.group}]`, checked.value);
    });

    // --- Total price summary ---
    fd.append('properties[Total Price]', `$${total.toFixed(2)}`);

    // ✅ UNIQUE TIMESTAMP to prevent Shopify from merging identical line items
    fd.append('properties[_timestamp]', Date.now());

    const resetButtonState = () => {
      if (!submitBtn) return;
      submitBtn.disabled = false;
      submitBtn.removeAttribute('aria-disabled');
      submitBtn.classList.remove('is-loading');
    };

    const setLoadingState = () => {
      if (!submitBtn) return;
      submitBtn.disabled = true;
      submitBtn.setAttribute('aria-disabled', 'true');
      submitBtn.classList.add('is-loading');
    };

    setLoadingState();

    try {
      if (window.CartDrawerAPI && typeof window.CartDrawerAPI.addToCart === 'function') {
        await window.CartDrawerAPI.addToCart(fd, submitBtn);
        clearFormAndScrollTop();
        resetButtonState();
        return;
      }

      const endpoint = typeof routes !== 'undefined' && routes?.cart_add_url ? routes.cart_add_url : '/cart/add.js';
      const config = typeof fetchConfig === 'function' ? fetchConfig('javascript') : { method: 'POST', headers: {} };
      config.headers = config.headers || {};
      config.headers['X-Requested-With'] = 'XMLHttpRequest';
      delete config.headers['Content-Type'];
      config.body = fd;

      const response = await fetch(endpoint, config);
      const text = await response.text();
      let data;
      try {
        data = text ? JSON.parse(text) : {};
      } catch (parseErr) {
        data = { status: 'error', description: text || 'Unknown error' };
      }

      if (!response.ok || data?.status === 'error') {
        const message = data?.description || data?.message || 'Error adding to cart';
        console.error('Film service add to cart error:', data);
        alert(message);
        resetButtonState();
        return;
      }

      // Clear and scroll on success before rendering/redirecting
      clearFormAndScrollTop();

      if (cartDrawer && typeof cartDrawer.renderContents === 'function') {
        cartDrawer.renderContents(data);
      } else if (typeof routes !== 'undefined' && routes?.cart_url) {
        window.location.href = routes.cart_url;
      } else {
        window.location.href = '/cart';
      }

      resetButtonState();
    } catch (err) {
      console.error(err);
      alert('Error adding to cart');
      resetButtonState();
    }
  });

  // Init
  applyConditions();
  updateDeliveryInfoVisibility();
  updateOrderSummaryVisibility();
});
