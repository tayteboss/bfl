document.addEventListener('DOMContentLoaded', () => {
  const form = document.querySelector('#film-service-form');
  if (!form) return;
  // Disable native constraint validation so our custom validator handles errors/scroll
  try {
    form.setAttribute('novalidate', 'novalidate');
  } catch (_) {}

  const totalDisplay = document.querySelector('#film-total-display');
  const osList = document.querySelector('[data-os-list]');
  const bottomTotalDisplay = document.querySelector('#bottom-film-total-display');
  const bottomOsList = document.querySelector('#bottom-os-list');
  const bottomOrderSummary = document.querySelector('#bottom-order-summary');
  const bottomAnchor = document.querySelector('#bottom-order-summary-anchor');
  const orderSummary = document.querySelector('[data-order-summary]');
  const qtyInput = form.querySelector('input[name="quantity"]');
  const qtyMinusBtn = form.querySelector('.quantity-btn--minus');
  const qtyPlusBtn = form.querySelector('.quantity-btn--plus');
  // Feature flag: show per-option prices in the Order Summary
  const OS_SHOW_PRICES = true;
  const basePrice = 0; // Removed base price as requested
  const variantInput = form.querySelector('input[name="id"]');
  const submitBtns = form.querySelectorAll('button[type="submit"]');
  const cartDrawer = document.querySelector('cart-drawer');
  const uploadlyContainer = form.querySelector('[data-uploadly-container]');
  const uploadlyFallbackButton = uploadlyContainer
    ? uploadlyContainer.querySelector('[data-uploadly-fallback-button]')
    : null;
  const uploadlyHasAppBlock = uploadlyContainer
    ? String(uploadlyContainer.dataset.uploadlyHasAppBlock || '').toLowerCase() === 'true'
    : false;
  const uploadlyStatusEl = uploadlyContainer ? uploadlyContainer.querySelector('[data-uploadly-status]') : null;
  // Visible-fallback state. Set once in-page recovery has clearly failed so the
  // fallback button can appear; `triggerUploadlyRecovery` is wired up inside
  // monitorUploadyMount so the button can re-run the recovery sequence on tap.
  let uploadlyRecoveryFailed = false;
  let triggerUploadlyRecovery = null;
  const serviceRadios = form.querySelectorAll('input[name="service"]');
  const serviceBlocks = form.querySelectorAll('.service-groups-wrapper');
  let total = basePrice;

  const errorEl = form.querySelector('[data-film-service-error]');
  const errorElBottom = form.querySelector('[data-film-service-error-bottom]');

  const setErrorMessage = (msg) => {
    const message = msg || '';
    if (errorEl) {
      errorEl.textContent = message;
      errorEl.style.display = message ? '' : 'none';
    }
    if (errorElBottom) {
      errorElBottom.textContent = message;
      errorElBottom.style.display = message ? '' : 'none';
    }
  };

  const getQuantity = () =>
    Math.max(1, parseInt((form.querySelector('input[name="quantity"]') || {}).value || '1', 10) || 1);

  // A registered Film Printing flow owns completion state. Send Rolls and the
  // existing uploader remain unchanged until an explicit supported mount exists.
  const printJobFlow = () => form.hasAttribute('data-film-printing-form')
    ? window.BFLPrintJob?.forForm(form) : null;

  const getActualFilesCount = () => {
    // Physical-negative orders never inherit the preceding digital upload count.
    const serviceRadio = form.querySelector('input[name="service"]:checked');
    if (serviceRadio && serviceRadio.value === 'Darkroom Prints') return 0;
    const flow = printJobFlow();
    if (flow) {
      const uploads = flow.snapshot();
      return uploads.displayCompletedCount ?? uploads.completedAssetIds.length;
    }
    // If Darkroom Prints is selected, the upload section is hidden and files are not required

    let domCount = 0;

    // 1. Try to count Uploadly DOM list items
    const listItems = Array.from(document.querySelectorAll('.uploadly-list-item, .uploady-list-item, .uploadly-file, .uploady-file, .uploadly-item, .uploady-item'));

    if (listItems.length > 0) {
      // Deduplicate nested elements (e.g. an item inside a list item wrapper)
      const validContainers = listItems.filter((el) => {
        let parent = el.parentElement;
        while (parent) {
          if (listItems.includes(parent)) return false;
          parent = parent.parentElement;
        }
        return true;
      });
      domCount = validContainers.length;
    }

    // 2. Count the hidden inputs injected by Uploadly
    let inputCount = 0;
    const fileKeys = new Set();
    const uploadInputs = Array.from(document.querySelectorAll('input[name*="properties"]')).filter((el) => {
      const nameStr = el.name.toLowerCase();
      if (
        nameStr.includes('[return delivery]') ||
        nameStr.includes('[turnaround]') ||
        nameStr.includes('[message]') ||
        nameStr.includes('[total price]') ||
        nameStr.includes('[_timestamp]') ||
        nameStr.includes('[delivery address]') ||
        nameStr.includes('[_return_shipping_required]') ||
        nameStr.includes('[files uploaded]') ||
        nameStr.includes('[_files uploaded]')
      ) {
        return false;
      }
      return el.value && el.value.trim() !== '';
    });

    uploadInputs.forEach(el => {
      const match = el.name.match(/properties\[(.*?)\]/);
      if (match && match[1]) {
        const key = match[1];
        const val = el.value.trim();

        // Only count properties that don't start with '_' (ignores internal thumbnails)
        if (!key.startsWith('_') && (val.includes('http') || val.includes('uploadly') || val.includes('uploady'))) {
          const urls = val.match(/https?:\/\/[^\s,]+/g);
          if (urls && urls.length > 1) {
            urls.forEach((u, idx) => fileKeys.add(`${key}_${idx}`));
          } else {
            fileKeys.add(key);
          }
        }
      }
    });
    inputCount = fileKeys.size;

    // 3. Add native file inputs (if any)
    const nativeFileInputs = Array.from(document.querySelectorAll('input[type="file"]')).reduce((sum, el) => sum + (el.files ? el.files.length : 0), 0);

    let count = Math.max(domCount, inputCount) + nativeFileInputs;

    return count;
  };

  const usesPhysicalNegatives = () => form.querySelector('input[name="service"]:checked')?.value === 'Darkroom Prints';
  const getUploadedFilesCount = () => printJobFlow() ? getActualFilesCount() : Math.max(1, getActualFilesCount());

  const hasUploadyWidgetMounted = () => {
    if (!uploadlyContainer) return false;
    // If the app block rendered any interactive UI in the container,
    // keep our fallback button hidden to avoid duplicate "Choose File" buttons.
    const genericInteractive = uploadlyContainer.querySelector(
      'button:not([data-uploadly-fallback-button]), [role="button"]:not([data-uploadly-fallback-button]), a[href], .uploady, .uploadly'
    );
    if (genericInteractive) return true;

    const selectors = [
      // Uploadly renders via an Uploadcare widget; these are the real mounted markers.
      '.uploadcare--widget',
      '.uploadcare--widget__button',
      '[data-ph-wrap]',
      '[id^="selBtn_"]',
      '.uploadly-button',
      '.uploady-button',
      '.uploadly-drop-zone',
      '.uploady-drop-zone',
      '.uploadly-list',
      '.uploady-list',
      '[data-uploadly-id]',
      'input[type="file"]',
    ];
    return selectors.some((selector) => !!uploadlyContainer.querySelector(selector));
  };

  const isThemePreviewContext = () => {
    try {
      const params = new URLSearchParams(window.location.search || '');
      if (params.has('preview_theme_id')) return true;
      if (window.Shopify && window.Shopify.designMode) return true;
    } catch (_) {}
    return false;
  };

  const shouldBypassUploadRequirementForPreview = () => {
    // Allow add-to-cart without upload only when:
    // - this is a preview context
    // - Uploady app block is configured
    // - Uploady failed to mount
    return isThemePreviewContext() && uploadlyHasAppBlock && !hasUploadyWidgetMounted();
  };

  // One-time cache-busting reload for the stale-cache case. Automatic calls are
  // loop-guarded via ?_uph and never run in the theme editor. A manual,
  // user-initiated reload passes force=true to always get a fresh load.
  const cacheBustingReload = (force) => {
    if (isThemePreviewContext()) return;
    let params;
    try {
      params = new URLSearchParams(window.location.search || '');
    } catch (_) {
      return;
    }
    if (!force && params.has('_uph')) return;
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('_uph', force ? String(Date.now()) : '1');
      window.location.replace(url.toString());
    } catch (_) {}
  };

  const syncUploadlyFallbackVisibility = () => {
    if (!uploadlyContainer || !uploadlyFallbackButton) return;
    if (uploadlyHasAppBlock) {
      // With an app block, keep the fallback hidden while we wait/recover. It
      // only appears once recovery has clearly failed and nothing mounted, so
      // the customer gets a visible control instead of an endless loader.
      const shouldShow = uploadlyRecoveryFailed && !hasUploadyWidgetMounted();
      uploadlyFallbackButton.style.display = shouldShow ? '' : 'none';
      return;
    }
    uploadlyFallbackButton.style.display = hasUploadyWidgetMounted() ? 'none' : '';
  };

  const syncUploadlyStatusVisibility = () => {
    if (!uploadlyStatusEl) return;
    // Show status only when app block is configured but UI isn't mounted yet.
    if (uploadlyHasAppBlock && !hasUploadyWidgetMounted()) {
      uploadlyStatusEl.style.display = '';
    } else {
      uploadlyStatusEl.style.display = 'none';
    }
  };

  const monitorUploadyMount = () => {
    if (!uploadlyHasAppBlock) return;

    let settled = false;

    const appBlockPlaceholder = () =>
      (uploadlyContainer || document).querySelector('[data-photouploadapp-product-json]');

    const checkNow = () => {
      if (settled) return true;
      if (hasUploadyWidgetMounted()) {
        settled = true;
        syncUploadlyStatusVisibility();
        syncUploadlyFallbackVisibility();
        return true;
      }
      // Keep the loader in sync while we wait.
      syncUploadlyStatusVisibility();
      return false;
    };

    checkNow();

    const mountObserver = new MutationObserver(() => {
      if (checkNow()) mountObserver.disconnect();
    });
    mountObserver.observe(uploadlyContainer || document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'id'],
    });

    // Safety-net polling in case a mutation is missed.
    const startedAt = Date.now();
    const poll = setInterval(() => {
      if (checkNow() || Date.now() - startedAt > 30000) {
        clearInterval(poll);
        mountObserver.disconnect();
      }
    }, 400);

    // ROOT-CAUSE RECOVERY.
    // The Uploadly app embed injects two independent scripts: uploadly.js and
    // (the Uploadcare library) uploadcarev2.js. They load unordered, so when
    // Uploadcare loses the race and isn't ready as Uploadly runs, Uploadly bails
    // and never builds the upload widget — leaving "Loading upload tool…"
    // forever. (This is why it works on some loads / hard refreshes but not
    // others, e.g. navigating in from another page.)
    //
    // When the placeholder is present but the widget hasn't mounted after a short
    // grace period, re-run the mount ourselves: make sure Uploadcare is loaded,
    // (re)load Uploadly so its mount routine exists, then invoke it. Verified
    // against the live storefront, including the failing race condition.
    const findScriptSrc = (needle, fallback) => {
      const tag = Array.from(document.scripts).find((s) => s.src && s.src.indexOf(needle) !== -1);
      return tag ? tag.src : fallback;
    };

    // Load a script once, keyed on window[key]. Resolves true on load, false on
    // error. A FAILED load is never cached: window[key] is cleared so a later
    // attempt re-injects. (Used for Uploadcare, where a load failure is a real
    // network failure we want to retry.)
    const loadScriptOnce = (src, key) => {
      if (window[key]) return window[key];
      window[key] = new Promise((resolve) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = () => resolve(true);
        s.onerror = () => {
          window[key] = null;
          resolve(false);
        };
        document.head.appendChild(s);
      });
      return window[key];
    };

    // Inject a script unconditionally (a fresh tag each call). Used for
    // uploadly.js: a successful script load does NOT guarantee it defined
    // window.ph_product_script — if uploadly.js ran before window.uploadcare
    // existed it bails WITHOUT defining its mount routine (yet onload still
    // fires). So once Uploadcare is present we must re-run uploadly.js, which a
    // load-once cache would wrongly skip.
    const injectScript = (src) =>
      new Promise((resolve) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = () => resolve(true);
        s.onerror = () => resolve(false);
        document.head.appendChild(s);
      });

    const waitFor = (cond, timeout) =>
      new Promise((resolve) => {
        if (cond()) return resolve(true);
        const start = Date.now();
        const t = setInterval(() => {
          if (cond() || Date.now() - start > timeout) {
            clearInterval(t);
            resolve(cond());
          }
        }, 100);
      });

    // Uploadly exposes two mount routines: ph_home_script (builds the
    // .photouploadapp widget on non-product pages) and ph_product_script
    // (product pages only — it reads product data and throws
    // "reading 'product'" on a /pages/ URL). This widget lives on
    // /pages/film-printing, so we mount via ph_home_script; ph_product_script
    // is only used as a fallback on an actual /products/ URL.
    const runUploadlyMount = () => {
      try {
        if (typeof window.ph_home_script === 'function') {
          window.ph_home_script();
          return true;
        }
        if (
          typeof window.ph_product_script === 'function' &&
          /\/products\//.test(window.location.pathname)
        ) {
          window.ph_product_script();
          return true;
        }
      } catch (_) {}
      return false;
    };

    const uploadlyMountReady = () =>
      typeof window.ph_home_script === 'function' ||
      typeof window.ph_product_script === 'function';

    let recovering = false;
    let uploadlyInjected = false;
    const recoverUpload = async () => {
      if (recovering || settled || hasUploadyWidgetMounted()) return;
      // Nothing to mount in-page if the app block rendered empty — that's the
      // separate stale-cache case handled by the reload fallback below.
      if (!appBlockPlaceholder()) return;
      recovering = true;
      try {
        // 1) Ensure Uploadcare is actually present (not just its tag loaded).
        if (typeof window.uploadcare === 'undefined') {
          await loadScriptOnce(
            findScriptSrc(
              'uploadcarev2',
              'https://cdn.shopify.com/s/files/1/0515/2384/6340/files/uploadcarev2.js'
            ),
            '__bflUploadcarePromise'
          );
          await waitFor(() => typeof window.uploadcare !== 'undefined', 4000);
        }
        // Without Uploadcare we can't build the widget; bail and retry next tick.
        if (typeof window.uploadcare === 'undefined') return;

        // 2) Ensure Uploadly's mount routines exist. If they're missing it
        //    bailed earlier (ran before Uploadcare) — re-inject uploadly.js
        //    ONCE so it re-runs and defines them.
        if (!uploadlyMountReady()) {
          if (!uploadlyInjected) {
            uploadlyInjected = true;
            await injectScript(findScriptSrc('uploadly.js', 'https://uploadly-cdn.com/uploadly.js'));
          }
          await waitFor(uploadlyMountReady, 4000);
        }

        // 3) Build the widget via the page-appropriate mount routine, then give
        //    it a moment to appear before the next attempt.
        if (!hasUploadyWidgetMounted() && uploadlyMountReady()) {
          runUploadlyMount();
          await waitFor(() => hasUploadyWidgetMounted(), 2000);
        }
      } finally {
        recovering = false;
        checkNow();
      }
    };

    // Expose recovery so the visible fallback button can re-run it on demand.
    triggerUploadlyRecovery = recoverUpload;

    // When recovery has clearly failed to mount the widget, surface a visible
    // control instead of an endless "Loading upload tool…".
    const markRecoveryFailed = () => {
      if (settled || hasUploadyWidgetMounted()) return;
      uploadlyRecoveryFailed = true;
      if (uploadlyStatusEl) {
        uploadlyStatusEl.textContent = "Upload tool didn't load.";
        uploadlyStatusEl.style.display = '';
      }
      if (uploadlyFallbackButton && !isThemePreviewContext()) {
        uploadlyFallbackButton.textContent = 'Retry upload tool';
      }
      syncUploadlyFallbackVisibility();
    };

    // Recover sooner and keep retrying on a short interval until the widget
    // mounts. The app's own (working) path may still win the race first; we
    // stop immediately once anything mounts.
    setTimeout(() => {
      if (!settled && !hasUploadyWidgetMounted()) recoverUpload();
    }, 1200);
    const recoveryStartedAt = Date.now();
    const recoveryTimer = setInterval(() => {
      if (settled || hasUploadyWidgetMounted()) {
        clearInterval(recoveryTimer);
        return;
      }
      if (Date.now() - recoveryStartedAt > 22000) {
        clearInterval(recoveryTimer);
        return;
      }
      recoverUpload();
    }, 1500);

    // After a clear timeout with no widget, reveal the visible fallback control.
    setTimeout(markRecoveryFailed, 13000);

    // Last-resort fallback: if the app block rendered EMPTY (placeholder missing,
    // e.g. a stale full-page-cache hit) there is nothing to recover in-page, so
    // force a one-time cache-busting reload. Guarded against loops; never in the
    // theme editor.
    const selfHealUpload = () => {
      if (settled || hasUploadyWidgetMounted()) return;
      cacheBustingReload(false);
    };

    setTimeout(() => {
      if (settled || hasUploadyWidgetMounted()) return;
      if (!appBlockPlaceholder()) selfHealUpload();
    }, 6000);

    // In a preview/design context, surface a clear message (we never auto-reload
    // the editor).
    setTimeout(() => {
      if (settled || hasUploadyWidgetMounted()) return;
      if (isThemePreviewContext() && uploadlyStatusEl) {
        uploadlyStatusEl.textContent =
          'Upload tool did not load in this preview. Open this theme in the customizer or view it live.';
        uploadlyStatusEl.style.display = '';
      }
    }, 15000);
  };

  const openUploadlyFromFallback = () => {
    // 1) Prefer Uploady/Uploadly interactive controls if mounted.
    const triggerSelectors = [
      '.uploadly-button',
      '.uploady-button',
      '[data-uploadly-open]',
      '[class*="uploadly-button"]',
      '[class*="uploady-button"]',
      '[class*="uploadly-trigger"]',
      '[class*="uploady-trigger"]',
    ];

    for (const selector of triggerSelectors) {
      const inContainer = uploadlyContainer ? uploadlyContainer.querySelector(selector) : null;
      const anywhere = document.querySelector(selector);
      const target = inContainer || anywhere;
      if (target && typeof target.click === 'function') {
        target.click();
        return true;
      }
    }

    // 2) Fall back to any file input if present.
    const fileInput =
      (uploadlyContainer && uploadlyContainer.querySelector('input[type="file"]')) ||
      document.querySelector('input[type="file"]');

    if (fileInput && typeof fileInput.click === 'function') {
      fileInput.click();
      return true;
    }

    return false;
  };

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

  const isActivePrintOption = (input) => {
    if (!printJobFlow()) return true;
    if (!input || input.disabled) return false;
    const label = input.closest('label');
    if (label?.classList.contains('is-unavailable') || !isVisible(label || input)) return false;
    const fieldset = input.closest('fieldset');
    if (fieldset && !isVisible(fieldset)) return false;
    const block = input.closest('.service-groups-wrapper');
    if (!block) return true;
    const service = form.querySelector('input[name="service"]:checked');
    return !!service && !service.disabled && !service.closest('label')?.classList.contains('is-unavailable') &&
      block.dataset.forService === service.value && isVisible(block);
  };

  const getVisibleFieldsets = () =>
    Array.from(form.querySelectorAll('fieldset.rolls-form-card')).filter((fs) => isVisible(fs));

  const getVisibleRadiosInFieldset = (fs) =>
    Array.from(fs.querySelectorAll('input[type="radio"]')).filter((r) => {
      const carrier = r.closest('label') || r;
      // Exclude unavailable options (faded out) from validation
      if (carrier && carrier.classList.contains('is-unavailable')) return false;
      return isVisible(carrier);
    });

  const customSizeContainer = form.querySelector('[data-custom-size-container]');
  const customSizeFieldset = customSizeContainer ? customSizeContainer.closest('fieldset.rolls-form-card') : null;
  const customSizeWidthInput = form.querySelector('[data-custom-size-input="width"]');
  const customSizeHeightInput = form.querySelector('[data-custom-size-input="height"]');
  const customSizeErrorEl = form.querySelector('[data-custom-size-error]');
  const customSizeTouched = { width: false, height: false };

  const setInlineError = (el, message) => {
    if (!el) return;
    el.textContent = message || '';
    el.style.display = message ? '' : 'none';
    if (message) {
      el.style.color = 'var(--color-error, var(--color-red, #d22d2d))';
      el.style.marginTop = '0.5rem';
    }
  };

  const isFineArtsCustomSizeActive = () => {
    const serviceRadio = form.querySelector('input[name="service"]:checked');
    const sizeRadio = form.querySelector('input[name="sizes"]:checked');
    return (
      serviceRadio &&
      serviceRadio.value === 'Fine Arts' &&
      sizeRadio &&
      (sizeRadio.value || '').trim().toLowerCase() === 'custom'
    );
  };

  const validateCustomDimension = (rawValue, opts) => {
    const options = opts || {};
    const label = options.label || 'Value';
    const hasMax = Number.isFinite(options.max);
    const max = options.max;
    const value = (rawValue || '').toString().trim();

    if (!value) {
      return { valid: false, message: `${label} is required.` };
    }

    if (!/^\d+$/.test(value)) {
      return { valid: false, message: `${label} must be a whole number.` };
    }

    const numericValue = Number(value);
    if (!Number.isSafeInteger(numericValue)) {
      return { valid: false, message: `${label} is too large.` };
    }

    if (numericValue < 1) {
      return { valid: false, message: `${label} must be at least 1.` };
    }

    if (hasMax && numericValue > max) {
      return { valid: false, message: `${label} must be ${max}" or less.` };
    }

    return { valid: true, numericValue, message: '' };
  };

  const getCustomSizeValidation = (opts) => {
    const options = opts || {};
    const showErrors = !!options.showErrors;
    const forceAll = !!options.forceAll;

    if (!customSizeContainer || !customSizeWidthInput || !customSizeHeightInput) {
      return { active: false, valid: true, width: null, height: null };
    }

    const active = isFineArtsCustomSizeActive() && isVisible(customSizeContainer);
    if (!active) {
      customSizeTouched.width = false;
      customSizeTouched.height = false;
      if (showErrors) {
        setInlineError(customSizeErrorEl, '');
      }
      return { active: false, valid: true, width: null, height: null };
    }

    const widthResult = validateCustomDimension(customSizeWidthInput.value, { label: 'Width', max: 44 });
    const heightResult = validateCustomDimension(customSizeHeightInput.value, { label: 'Height' });
    const isValid = widthResult.valid && heightResult.valid;

    if (showErrors) {
      const canShowWidth = forceAll || customSizeTouched.width;
      const canShowHeight = forceAll || customSizeTouched.height;
      let errorMessage = '';

      if (canShowWidth && !widthResult.valid) {
        errorMessage = widthResult.message;
      } else if (canShowHeight && !heightResult.valid) {
        errorMessage = heightResult.message;
      }

      if (!errorMessage && forceAll && !isValid) {
        errorMessage = !widthResult.valid ? widthResult.message : heightResult.message;
      }

      setInlineError(customSizeErrorEl, errorMessage);
    }

    return {
      active,
      valid: isValid,
      width: widthResult.valid ? widthResult.numericValue : null,
      height: heightResult.valid ? heightResult.numericValue : null,
    };
  };

  const getFineArtsCustomSizePrice = (width, height, paperLabel) => {
    const area = Number(width || 0) * Number(height || 0);
    const normalizedPaper = (paperLabel || '').toString().trim().toLowerCase();
    const isFibre = normalizedPaper === 'fibre paper';
    const rawPrice = isFibre ? 3 + 0.073 * area : 12 + 0.04 * area;
    return Math.round(rawPrice);
  };

  const syncCustomSizePrice = (showErrors = false) => {
    const customSizeRadio = form.querySelector('input[name="sizes"][value="Custom"]');
    if (!customSizeRadio) return;

    const validation = getCustomSizeValidation({ showErrors });
    let newPrice = 0;

    if (validation.active && validation.valid) {
      const selectedPaper = form.querySelector('input[name="paper"]:checked');
      // Owned Custom prints need an explicit, available Fibre Paper selection.
      // Missing paper must not fall through to the legacy non-Fibre formula.
      if (!printJobFlow() || selectedPaper?.value === 'Fibre Paper' && isActivePrintOption(selectedPaper)) {
        newPrice = getFineArtsCustomSizePrice(validation.width, validation.height, selectedPaper?.value || '');
      }
    }

    customSizeRadio.dataset.price = newPrice;
    const customSizeLabel = customSizeRadio.closest('label');
    const customSizePriceEl = customSizeLabel ? customSizeLabel.querySelector('.opt-price') : null;
    if (customSizePriceEl) {
      customSizePriceEl.textContent = newPrice > 0 ? `$${newPrice}` : 'Free';
    }
  };

  const osWrapper = document.querySelector('.os-wrapper');

  // --- Order Summary floating visibility ---
  function updateOrderSummaryVisibility() {
    if (!osWrapper) return;

    const locationSelected = !!form.querySelector('input[name="location"]:checked');

    if (!locationSelected) {
      osWrapper.classList.remove('is-visible');
      osWrapper.classList.remove('is-expanded');
      setTimeout(() => {
        if (!osWrapper.classList.contains('is-visible')) {
          osWrapper.style.display = 'none';
          if (bottomOrderSummary) bottomOrderSummary.style.display = 'none';
        }
      }, 400);
      return;
    }

    // It should be visible
    osWrapper.style.display = '';
    if (bottomOrderSummary) bottomOrderSummary.style.display = 'block';

    setTimeout(() => {
      osWrapper.classList.add('is-visible');
    }, 10);

    // Handle scroll-based hiding of the floating summary
    let isPastBottomAnchor = false;

    if (bottomAnchor) {
      const anchorRect = bottomAnchor.getBoundingClientRect();
      // Hide floating summary when the static bottom summary enters the viewport
      isPastBottomAnchor = anchorRect.top < window.innerHeight;
    }

    if (isPastBottomAnchor) {
      osWrapper.classList.add('is-hidden-by-scroll');
    } else {
      osWrapper.classList.remove('is-hidden-by-scroll');
    }
  }

  window.addEventListener('scroll', updateOrderSummaryVisibility, { passive: true });
  window.addEventListener('resize', updateOrderSummaryVisibility, { passive: true });

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
    if (customSizeContainer && !isVisible(customSizeContainer)) {
      setInlineError(customSizeErrorEl, '');
    }
  };

  const validateOpenFields = ({ showErrors = true } = {}) => {
    const errors = [];
    getVisibleFieldsets().forEach((fs) => {
      let isInvalid = false;
      const groupNameAttr = fs.getAttribute('data-group') || fs.dataset.group || '';

      // 1. Radio Validation
      const visibleRadios = getVisibleRadiosInFieldset(fs);
      if (visibleRadios.length > 0) {
        // Special case: the aggregated "Add Ons" card contains multiple logical radio groups.
        if (groupNameAttr.trim().toLowerCase() === 'add ons') {
          const groupsByName = new Map();
          visibleRadios.forEach((r) => {
            const name = r.name || '__anon__';
            if (!groupsByName.has(name)) groupsByName.set(name, []);
            groupsByName.get(name).push(r);
          });

          const hasMissingGroupSelection = Array.from(groupsByName.values()).some((groupRadios) => {
            if (!groupRadios.length) return false;
            return !groupRadios.some((r) => r.checked);
          });
          if (hasMissingGroupSelection) isInvalid = true;
        } else {
          // Default behavior: at least one visible radio in this fieldset must be selected
          const anyChecked = visibleRadios.some((r) => r.checked);
          if (!anyChecked) isInvalid = true;
        }
      }

      // 2. Text/Select Validation (e.g. Address fields)
      const requiredInputs = Array.from(
        fs.querySelectorAll(
          'input:not([type="radio"]):not([type="checkbox"])[required], select[required], textarea[required]'
        )
      ).filter((el) => isVisible(el) && !el.disabled);

      if (requiredInputs.some((el) => !el.value.trim())) {
        isInvalid = true;
      }

      // 2b. Custom size validation
      if (customSizeContainer && fs.contains(customSizeContainer)) {
        const customValidation = getCustomSizeValidation({ showErrors, forceAll: true });
        if (customValidation.active && !customValidation.valid) {
          isInvalid = true;
        }
      }

      // If no radios and no required inputs, we consider it valid (unless we want to enforce logic for info-only cards, which we don't)
      if (visibleRadios.length === 0 && requiredInputs.length === 0) {
        isInvalid = false;
      }

      // 3. Upload Validation (Uploadly)
      if (groupNameAttr.trim().toLowerCase() === 'upload') {
        const ownedUploads = printJobFlow()?.snapshot();
        if (ownedUploads) {
          isInvalid = !!(ownedUploads.pending || ownedUploads.failed || !ownedUploads.completedAssetIds.length);
        } else if (shouldBypassUploadRequirementForPreview()) {
          isInvalid = false;
        } else {
        // Uploadly sometimes dynamically generates the fields, wait to check form fields specifically
        // Find inputs that contain Uploadly data (Uploadly often targets hidden inputs or adds properties)
        const uploadInputs = Array.from(document.querySelectorAll('input[name*="properties"]')).filter((el) => {
          const nameStr = el.name.toLowerCase();
          if (
            nameStr.includes('[return delivery]') ||
            nameStr.includes('[turnaround]') ||
            nameStr.includes('[message]') ||
            nameStr.includes('[total price]') ||
            nameStr.includes('[_timestamp]')
          ) {
            return false;
          }
          return true;
        });

        // Use document.querySelector to see if Uploadly widget actually attached a file
        // Uploadly widget creates items with class .uploadly-item or .uploadly-file
        const uploadlyItems = document.querySelectorAll(
          '.uploadly-item, .uploadly-file, .uploadly-list-item, .uploadly-preview, .uploady-item, .uploady-list-item, .uploady-preview, [data-uploadly-id], [class*="uploadly-"], [class*="uploady-"]'
        );

        // Also check if Uploadly added its success class to the body or container
        const hasUploadySuccess = document.querySelector('.uploady-success, .uploadly-success') !== null;

        const hasUploadedFile =
          uploadInputs.some((el) => el.value && el.value.trim() !== '') ||
          uploadlyItems.length > 0 ||
          hasUploadySuccess;

        // As a fallback, check if there's any file input with a file selected
        const fileInputs = Array.from(document.querySelectorAll('input[type="file"]'));
        const hasNativeFile = fileInputs.some((el) => el.files && el.files.length > 0);

        if (!hasUploadedFile && !hasNativeFile) {
          isInvalid = true;
        }
        }
      }

      if (isInvalid) {
        errors.push(fs);
        if (!showErrors) return;
        fs.classList.add('rolls-form-card--error');

        // Add explicit error message for Upload if not present
        if (groupNameAttr.trim().toLowerCase() === 'upload') {
          let errorMsg = fs.querySelector('.upload-error-msg');
          if (!errorMsg) {
            errorMsg = document.createElement('p');
            errorMsg.className = 'upload-error-msg type-p-small';
            errorMsg.style.color = 'var(--color-error, var(--color-red, #d22d2d))';
            errorMsg.style.marginTop = '0.5rem';
            errorMsg.textContent = 'Please upload a file to continue.';
            const inner = fs.querySelector('.rolls-form-card__inner');
            if (inner) inner.appendChild(errorMsg);
          }
        }
      } else if (showErrors) {
        fs.classList.remove('rolls-form-card--error');
        if (groupNameAttr.trim().toLowerCase() === 'upload') {
          const errorMsg = fs.querySelector('.upload-error-msg');
          if (errorMsg) errorMsg.remove();
        }
      }
    });
    return { errors };
  };
  // Explicit form-local hook; background preparation never paints errors or
  // introduces controls before the shopper submits the supplied form.
  form.bflSelectionComplete = () => validateOpenFields({ showErrors: false }).errors.length === 0 &&
    !(() => { const size = getCustomSizeValidation({ showErrors: false, forceAll: true }); return size.active && !size.valid; })() && total <= 2000;

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

  // Add click listener for mobile support to expand the summary
  if (orderSummary) {
    const osHeader = orderSummary.querySelector('.order-summary__header');
    if (osHeader) {
      osHeader.style.cursor = 'pointer';
      osHeader.addEventListener('click', () => {
        orderSummary.classList.toggle('is-expanded');
      });
    }
  }

  // --- UI helpers for Order Summary ---
  const formatMoney = (num) => `$${Number(num || 0).toFixed(2)}`;

  const createRow = (listEl, labelText, valueText, priceNum) => {
    if (!listEl) return;
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
    listEl.appendChild(row);
  };

  const renderSummary = () => {
    if (osList) osList.innerHTML = '';
    if (bottomOsList) bottomOsList.innerHTML = '';

    // Fieldsets in DOM order with checked radios
    form.querySelectorAll('fieldset.rolls-form-card').forEach((fs) => {
      if (printJobFlow() && !isVisible(fs)) return;
      // Special handling for grouped "Add Ons" fieldset
      if (fs.dataset.group === 'Add Ons') {
        const checkedRadios = fs.querySelectorAll('input[type="radio"]:checked');
        checkedRadios.forEach((radio) => {
          if (!isActivePrintOption(radio)) return;
          const val = (radio.value || '').trim();
          // Skip "No" or empty values for Add Ons in summary
          if (!val || val.toLowerCase() === 'no') return;

          // Derive label from name: "add-ons-contact-sheet" -> "Contact Sheet"
          let label = radio.name || 'Add On';
          label = label.replace(/^add-ons-/, '').replace(/-/g, ' ');
          // Title Case
          label = label.replace(/\b\w/g, (c) => c.toUpperCase());

          const priceNum = Number(radio.dataset.price || 0);
          createRow(osList, label, val, priceNum);
          createRow(bottomOsList, label, val, priceNum);
        });
        return;
      }

      // Special handling for Delivery Options fieldset which has multiple questions
      if (fs.dataset.group === 'Delivery Options') {
        const checkedRadios = fs.querySelectorAll('input[type="radio"]:checked');
        checkedRadios.forEach((radio) => {
          if (!isActivePrintOption(radio)) return;
          let label = radio.name || 'Delivery Option';
          // Extract text inside brackets, e.g. properties[Return Delivery] -> Return Delivery
          const match = label.match(/\[(.*?)\]/);
          if (match && match[1]) label = match[1];

          let valueText = (radio.value || '').trim();
          // Skip default standard options if we don't want to clutter the summary, or keep them.
          // Since it's a core choice, we'll keep them.

          let priceNum = Number(radio.dataset.price || 0);

          // If this is Turnaround, calculate the dynamic price modifier
          if (label === 'Turnaround') {
            // Calculate base total before multiplier to find the added cost
            let preTotal = basePrice;
            form.querySelectorAll('input[type="radio"]:checked').forEach((input) => {
              if (!isActivePrintOption(input)) return;
              preTotal += Number(input.dataset.price || 0);
            });
            const turnaroundValue = valueText.toLowerCase();
            if (turnaroundValue.includes('rush')) {
              priceNum = preTotal * 1; // (Total * 2 means it adds preTotal * 1)
            } else if (turnaroundValue.includes('speedy')) {
              priceNum = preTotal * 0.5; // (Total * 1.5 means it adds preTotal * 0.5)
            }
          }

          createRow(osList, label, valueText, priceNum);
          createRow(bottomOsList, label, valueText, priceNum);
        });
        return;
      }

      const checked = fs.querySelector('input[type="radio"]:checked');
      if (!checked || !isActivePrintOption(checked)) return;
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
      createRow(osList, labelText, valueText, priceNum);
      createRow(bottomOsList, labelText, valueText, priceNum);
    });

    const customValidation = getCustomSizeValidation({ showErrors: false });
    if (customValidation.active && customValidation.valid) {
      const valueText = `${customValidation.width}" × ${customValidation.height}"`;
      createRow(osList, 'Custom Dimensions', valueText, 0);
      createRow(bottomOsList, 'Custom Dimensions', valueText, 0);
    }

    // --- Totals area (consider quantity) ---
    const qty = getQuantity();
    const fileCount = getUploadedFilesCount();
    const multiplier = qty * (usesPhysicalNegatives() ? 1 : fileCount);
    const perRoll = Number(total || 0);
    const grand = perRoll * multiplier;

    // Shipping estimate for this print line (Film Printing only). The real
    // charge is calculated at checkout and is $0 with in-store pickup.
    if (getSizeShippingHandle()) {
      const shipPlan = planPrintShipping(getSelectedPrintDims(customValidation), multiplier);
      const shipEst = estimatePrintShipping(shipPlan);
      if (shipEst !== null) {
        const shipText = `${formatMoney(shipEst)} est. (free with in-store pickup)`;
        createRow(osList, 'Shipping', shipText, 0);
        createRow(bottomOsList, 'Shipping', shipText, 0);
      }
    }

    if (multiplier > 1) {
      if (fileCount > 1) {
        createRow(osList, 'Files Uploaded', String(fileCount), 0);
        createRow(bottomOsList, 'Files Uploaded', String(fileCount), 0);
      }
      if (qty > 1) {
        createRow(osList, usesPhysicalNegatives() ? 'Copies' : 'Copies per file', String(qty), 0);
        createRow(bottomOsList, usesPhysicalNegatives() ? 'Copies' : 'Copies per file', String(qty), 0);
      }
      createRow(osList, 'Subtotal', `${multiplier} × ${formatMoney(perRoll)}`, grand);
      createRow(osList, 'Total', formatMoney(grand), 0);

      createRow(bottomOsList, 'Subtotal', `${multiplier} × ${formatMoney(perRoll)}`, grand);
      createRow(bottomOsList, 'Total', formatMoney(grand), 0);
    } else {
      createRow(osList, 'Total', formatMoney(grand), 0);
      createRow(bottomOsList, 'Total', formatMoney(grand), 0);
    }
  };

  // --- Total calc ---
  function calculateTotal() {
    syncCustomSizePrice(false);

    total = basePrice;
    form.querySelectorAll('input[type="radio"]:checked').forEach((input) => {
      if (!isActivePrintOption(input)) return;
      total += Number(input.dataset.price || 0);
    });

    // Apply multiplier based on Turnaround selection
    const turnaroundRadio = form.querySelector('input[name="properties[Turnaround]"]:checked');
    if (turnaroundRadio && isActivePrintOption(turnaroundRadio)) {
      const turnaroundValue = (turnaroundRadio.value || '').toLowerCase();
      if (turnaroundValue.includes('rush')) {
        total *= 2;
      } else if (turnaroundValue.includes('speedy')) {
        total *= 1.5;
      }
    }

    const qty = getQuantity();
    const fileCount = getUploadedFilesCount();
    const multiplier = qty * (usesPhysicalNegatives() ? 1 : fileCount);
    const displayTotal = total * multiplier;

    if (totalDisplay) totalDisplay.textContent = formatMoney(displayTotal);
    if (bottomTotalDisplay) bottomTotalDisplay.textContent = formatMoney(displayTotal);
    // Clear any previous high-price error when recalculating
    setErrorMessage('');
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

      // Keep unavailable Film Printing services and papers inert before native
      // selection can displace a valid choice. Existing faded labels stay visible.
      if (form.hasAttribute('data-film-printing-form') && ['service', 'paper'].includes(radio.name)) radio.disabled = !shouldShow;

      // Fade out unavailable options instead of hiding them completely
      if (shouldShow) {
        label.classList.remove('is-unavailable');
      } else {
        label.classList.add('is-unavailable');
        if (radio.checked) radio.checked = false;
      }

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
            // Don't override visibility here - let show_if control it
            // We only guarantee the primary is enabled and checked if it's visible
            r.disabled = false;
            r.checked = true;
            // Remove unavailable class if it was previously locked
            if (label) label.classList.remove('is-unavailable');
          } else {
            // Don't override visibility here - let show_if control it
            // Only uncheck and disable non-primary options, and mark as unavailable
            r.checked = false;
            r.disabled = true;
            r.dataset.lockedByDefaultIf = 'true';
            // Mark as unavailable so it's visually faded
            if (label) label.classList.add('is-unavailable');
          }
        });
      } else {
        // No active default_if: restore radios previously locked by default_if
        radios.forEach((r) => {
          if (r.dataset.lockedByDefaultIf === 'true') {
            const label = r.closest('label');
            r.disabled = false;
            delete r.dataset.lockedByDefaultIf;
            // Don't remove unavailable class here - let show_if logic control it
            // The show_if re-evaluation below will set the correct state
          }
        });
      }
    });

    // Re-evaluate show_if visibility for all radios after default_if logic
    // This ensures visibility is correct even after default_if may have changed selections
    form.querySelectorAll('input[type="radio"]').forEach((radio) => {
      const label = radio.closest('label');
      if (!label) return;

      // Skip radios that are currently locked by default_if (they should stay unavailable)
      if (radio.dataset.lockedByDefaultIf === 'true') {
        return;
      }

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

      const showIfRaw = radio.dataset.showIf;
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

      // A prior default_if lock may have been released in this pass.
      if (form.hasAttribute('data-film-printing-form') && ['service', 'paper'].includes(radio.name)) radio.disabled = !shouldShow;

      // Fade out unavailable options instead of hiding them completely
      if (shouldShow) {
        label.classList.remove('is-unavailable');
      } else {
        label.classList.add('is-unavailable');
        if (radio.checked) radio.checked = false;
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

      // Hide entire fieldsets/sections completely when unavailable (only fade individual options)
      if (shouldShow) {
        section.style.display = '';
        section.classList.remove('is-unavailable');
      } else {
        section.style.display = 'none';
        section.classList.remove('is-unavailable');
        // Uncheck all radios in section if it becomes hidden
        section.querySelectorAll('input[type="radio"]:checked').forEach((radio) => {
          radio.checked = false;
        });
      }
    });

    if (printJobFlow()) {
      const service = form.querySelector('input[name="service"]:checked');
      serviceBlocks.forEach((block) => {
        block.style.display = service && !service.disabled && block.dataset.forService === service.value ? 'flex' : 'none';
      });
    }

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
          const quantityFs = form.querySelector('fieldset[data-group="Add Ons"]');
          if (quantityFs) {
            scrollToFieldset(quantityFs, 100);
            handledScroll = true;
          }
        } else if (groupKey === 'sizes' && valueNorm === 'custom') {
          // Keep focus in Sizes so users can fill custom width/height immediately.
          handledScroll = true;
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
    } else if (e.target.matches('[data-custom-size-input]')) {
      // React to custom width/height changes
      getCustomSizeValidation({ showErrors: true });
      calculateTotal();
    }
  });

  form.addEventListener('input', (e) => {
    if (e.target.matches('input[name="quantity"]')) {
      calculateTotal();
    } else if (e.target.matches('[data-custom-size-input]')) {
      getCustomSizeValidation({ showErrors: true });
      calculateTotal();
    }
  });

  form.addEventListener('focusout', (e) => {
    if (e.target === customSizeWidthInput) {
      customSizeTouched.width = true;
      getCustomSizeValidation({ showErrors: true });
    } else if (e.target === customSizeHeightInput) {
      customSizeTouched.height = true;
      getCustomSizeValidation({ showErrors: true });
    }
  });

  // Match variant by price on the main form product only (single product with up to 2048 variants)
  // Async to allow fetching missing variants if needed
  async function findVariantByPrice(priceDollars) {
    // For prices under $1, the format is usually 0.X. E.g. $0.40 -> 40 cents.
    // The variant title should be "0.40" (string representation of the price) or "40" if you name it in cents.
    // Standard setup: title matches string of price dollars e.g. "0.4"
    const cents = Math.round(priceDollars * 100);

    let variants = Array.isArray(window.filmServiceVariants) ? window.filmServiceVariants : [];

    // Helper to find in list
    const find = (list) => list.find((v) => Number(v.price) === cents);

    let variant = find(variants);

    // Fallback: If exact price match fails, try matching Title == PriceDollars (e.g. Title "21" or "0.4")
    if (!variant) {
      // Create variations to check against
      const asString = String(priceDollars);
      const asFixed = Number(priceDollars).toFixed(2);
      const asCents = String(cents);
      const withoutLeadingZero = asString.startsWith('0.') ? asString.substring(1) : asString;
      const withoutLeadingZeroFixed = asFixed.startsWith('0.') ? asFixed.substring(1) : asFixed;
      // Additionally check for formats like "0.40" vs ".40"
      const withoutLeadingZeroCents = asFixed.replace(/^0\./, '.');

      const titleMatch = variants.find((v) => {
        const t = v.title;
        // Only allow matching raw cents string if the price is $1 or more, to avoid 0.40 ($0.40) matching the "40" ($40.00) variant
        const isCentsMatch = priceDollars >= 1 ? t === asCents : false;

        return (
          t === asString ||
          t === asFixed ||
          isCentsMatch ||
          t === withoutLeadingZero ||
          t === withoutLeadingZeroFixed ||
          t === withoutLeadingZeroCents
        );
      });

      if (titleMatch) {
        variant = titleMatch;
      }
    }

    // If not found, and we suspect truncation (or just missing), try fetching full JSON
    // Only attempt if not previously rate limited
    if (!variant && window.filmServiceProductHandle && !window.rateLimitFilmVariants) {
      try {
        // Use custom view to get ALL variants (bypassing default 250 limit)
        const ts = Date.now();
        const res = await fetch(`/products/${window.filmServiceProductHandle}?view=film-service-variants&t=${ts}`);
        if (res.ok) {
          const productData = await res.json();
          const vars = (productData.variants || []).filter((v) => v !== null);

          if (vars.length > 0) {
            window.filmServiceVariants = vars; // Update global cache
            variants = vars;
            variant = find(variants);

            // Re-check title match if still not found
            if (!variant) {
              const asString = String(priceDollars);
              const asFixed = Number(priceDollars).toFixed(2);
              const asCents = String(cents);
              const withoutLeadingZero = asString.startsWith('0.') ? asString.substring(1) : asString;
              const withoutLeadingZeroFixed = asFixed.startsWith('0.') ? asFixed.substring(1) : asFixed;

              // Additionally check for formats like "0.40" vs ".40"
              const withoutLeadingZeroCents = asFixed.replace(/^0\./, '.');

              const titleMatchRetry = variants.find((v) => {
                const t = v.title;
                const isCentsMatch = priceDollars >= 1 ? t === asCents : false;
                return (
                  t === asString ||
                  t === asFixed ||
                  isCentsMatch ||
                  t === withoutLeadingZero ||
                  t === withoutLeadingZeroFixed ||
                  t === withoutLeadingZeroCents
                );
              });

              if (titleMatchRetry) variant = titleMatchRetry;
            }
          }
        } else if (res.status === 429) {
          window.rateLimitFilmVariants = true;
        }
      } catch (e) {}
    }

    // If still not found, try the Search API as a last resort (for variants > 250)
    // Only attempt if not previously rate limited
    if (!variant && window.filmServiceProductHandle && !window.rateLimitSearchVariants) {
      try {
        // Search for the variant Title (which we assume matches the priceDollars, e.g., "21")
        const searchRes = await fetch(`/search?q=${priceDollars}&view=variant-id&type=product`);
        if (searchRes.ok) {
          const searchData = await searchRes.json();
          // Find exact match for price
          const found = searchData.find((v) => v.price === cents);
          if (found) {
            return {
              id: found.id,
              price: found.price,
              title: found.title,
              available: true,
            };
          }
        } else if (searchRes.status === 429) {
          window.rateLimitSearchVariants = true;
        }
      } catch (e) {}
    }

    if (!variant) {
      console.warn('No variant found at exact price on main film service product.', {
        priceDollars,
        cents,
        variantsCount: variants.length,
      });
    }

    return variant;
  }

  function prefillAddressFields() {
    try {
      const stored = localStorage.getItem('bellows_delivery_address');
      if (!stored) return;
      const addressData = JSON.parse(stored);

      form
        .querySelectorAll(
          'fieldset[data-group="Delivery Address"] input, fieldset[data-group="Delivery Address"] select'
        )
        .forEach((input) => {
          if (!input.name || !input.name.includes('properties[')) return;
          const key = input.name.match(/properties\[(.*?)\]/)?.[1];
          if (key && addressData[key]) {
            input.value = addressData[key];
          }
        });
    } catch (e) {
      console.error('Error loading address', e);
    }
  }

  function clearFormAndScrollTop() {
    try {
      form.reset();
    } catch (_) {}
    // Hide all service groups after reset
    serviceBlocks.forEach((block) => (block.style.display = 'none'));
    if (printJobFlow()) {
      form.querySelectorAll('.rolls-form-card--error').forEach(node => node.classList.remove('rolls-form-card--error'));
      form.querySelectorAll('.upload-error-msg').forEach(node => node.remove());
      setInlineError(customSizeErrorEl, '');
      setErrorMessage('');
    }
    // Reset totals and summary
    if (totalDisplay) totalDisplay.textContent = formatMoney(basePrice);
    if (osList) osList.innerHTML = '';

    // Restore address if present
    prefillAddressFields();

    applyConditions();
    updateOrderSummaryVisibility();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ---------------------------------------------------------------------------
  // Print Packaging companion (Film Printing only)
  //
  // Film Printing itself does not require shipping (its price is set by the
  // Cart Transform). To make checkout collect an address and charge shipping,
  // we add a $0 hidden "Print Packaging" product (handle: print-shipping)
  // alongside every print line.
  // Its variants carry *billing weights*, and the weight-based rate table in
  // the "Film Printing Shipping" delivery profile converts those into the
  // shipping charge:
  //
  //   Flat mailer (small)    1 lb  -> $10
  //   Flat mailer (medium)   2 lb  -> $16
  //   Flat mailer (large)    4 lb  -> $22
  //   Shipping tube (small) 10 lb  -> $22   (prints up to 24x30, N per tube)
  //   Shipping tube (large) 40 lb  -> $33   (prints over 24x30, N per tube)
  //
  // Variants are matched by title first and by billing weight as a fallback,
  // so the customer-facing names can be changed in Admin without breaking this.
  //
  // Weights add across lines, and the rate table is additive, so mixed carts
  // are priced correctly. Because it is a real shipping rate (not a product
  // price), choosing in-store pickup at checkout removes it automatically.
  // ---------------------------------------------------------------------------
  const DEFAULT_SIZE_SHIPPING_HANDLE = 'print-shipping';
  const DEFAULT_TUBE_CAPACITY = 8;
  const PAPER_GSM = 300;

  // Package classification limits (inches). Anything larger than a small tube
  // goes in a large tube.
  const FLAT_MAX_LONG = 16;
  const FLAT_MAX_SHORT = 12;
  const SMALL_TUBE_MAX_LONG = 30;
  const SMALL_TUBE_MAX_SHORT = 24;

  // Flat mailer tiers by total paper weight (lb) in the line.
  const FLAT_A_MAX_LB = 0.75;
  const FLAT_B_MAX_LB = 2.5;

  // Rate table limit: the profile has rows for up to 3 small tubes (10 lb
  // each); a 4th would weigh the same as one large tube, so overflow small
  // tubes are billed as large tubes instead.
  const MAX_SMALL_TUBES = 3;

  // Companion variant names (as set on the "Print Packaging" product in Admin).
  const PKG_FLAT_S = 'Flat mailer (small)';
  const PKG_FLAT_M = 'Flat mailer (medium)';
  const PKG_FLAT_L = 'Flat mailer (large)';
  const PKG_TUBE_S = 'Shipping tube (small)';
  const PKG_TUBE_L = 'Shipping tube (large)';

  // Mirror of the delivery-profile prices, used only for the on-page estimate.
  const SHIP_EST = {
    [PKG_FLAT_S]: 10,
    [PKG_FLAT_M]: 16,
    [PKG_FLAT_L]: 22,
    [PKG_TUBE_S]: 22,
    [PKG_TUBE_L]: 33,
    catchAll: 200,
    catchAllWeightLb: 120,
  };
  // Billing weight (lb) of each companion variant; also used to match variants by weight.
  const VARIANT_WEIGHTS = {
    [PKG_FLAT_S]: 1,
    [PKG_FLAT_M]: 2,
    [PKG_FLAT_L]: 4,
    [PKG_TUBE_S]: 10,
    [PKG_TUBE_L]: 40,
  };
  const GRAMS_PER_LB = 453.592;

  const getSizeShippingHandle = () => {
    if (window.sizeShippingProductHandle) return window.sizeShippingProductHandle;
    if (window.filmServiceProductHandle === 'film-printing') {
      window.sizeShippingProductHandle = DEFAULT_SIZE_SHIPPING_HANDLE;
      return window.sizeShippingProductHandle;
    }
    return '';
  };

  const getTubeCapacity = () => {
    const n = parseInt(window.tubeCapacity, 10);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_TUBE_CAPACITY;
  };

  const mapSizeShippingVariants = (variants) =>
    (variants || []).map((variant) => ({
      id: variant.id,
      title: variant.title,
      weight: variant.weight,
    }));

  const ensureSizeShippingVariants = async () => {
    if (Array.isArray(window.sizeShippingVariants) && window.sizeShippingVariants.length > 0) {
      return window.sizeShippingVariants;
    }

    const handle = getSizeShippingHandle();
    if (!handle) return [];

    try {
      const response = await fetch(`/products/${encodeURIComponent(handle)}.js`);
      if (!response.ok) return [];
      const product = await response.json();
      window.sizeShippingVariants = mapSizeShippingVariants(product.variants);
      return window.sizeShippingVariants;
    } catch (error) {
      console.error('Error loading print shipping variants', error);
      return [];
    }
  };

  const normSizeLabel = (value) =>
    (value || '').replace(/[^0-9xX×.]/g, '').replace(/[×X]/g, 'x').toLowerCase();

  const parseSizeDims = (value) => {
    const text = normSizeLabel(value);
    const match = text.match(/(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)/i);
    if (!match) return null;
    const a = Number(match[1]);
    const b = Number(match[2]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    const shortSide = Math.min(a, b);
    const longSide = Math.max(a, b);
    return { shortSide, longSide, area: shortSide * longSide };
  };

  // Dimensions of the print currently configured on the form.
  const getSelectedPrintDims = (customValidation) => {
    if (customValidation && customValidation.active && customValidation.valid) {
      const a = Number(customValidation.width);
      const b = Number(customValidation.height);
      if (Number.isFinite(a) && Number.isFinite(b) && a > 0 && b > 0) {
        return { shortSide: Math.min(a, b), longSide: Math.max(a, b) };
      }
    }
    const sizeRadio = form.querySelector('fieldset[data-group="Sizes"] input[type="radio"]:checked');
    const dims = parseSizeDims(sizeRadio ? sizeRadio.value : '');
    return dims ? { shortSide: dims.shortSide, longSide: dims.longSide } : null;
  };

  const classifyPackage = (dims) => {
    if (dims.longSide <= FLAT_MAX_LONG && dims.shortSide <= FLAT_MAX_SHORT) return 'flat';
    if (dims.longSide <= SMALL_TUBE_MAX_LONG && dims.shortSide <= SMALL_TUBE_MAX_SHORT) return 'small_tube';
    return 'large_tube';
  };

  // Weight of one sheet of 300gsm paper, in pounds.
  const paperWeightLb = (dims) => ((dims.shortSide * dims.longSide) / 1550.0031) * (PAPER_GSM / 1000) * 2.20462;

  // Decide which companion variant(s) and quantities a print line needs.
  // Returns { package, lines: [{ title, quantity }] } or null.
  const planPrintShipping = (dims, physicalCount) => {
    if (!dims) return null;
    const count = Math.max(1, parseInt(physicalCount, 10) || 1);
    const pkg = classifyPackage(dims);

    if (pkg === 'flat') {
      const lb = paperWeightLb(dims) * count;
      let title = PKG_FLAT_S;
      if (lb > FLAT_B_MAX_LB) title = PKG_FLAT_L;
      else if (lb > FLAT_A_MAX_LB) title = PKG_FLAT_M;
      return { package: pkg, lines: [{ title, quantity: 1 }] };
    }

    const tubes = Math.ceil(count / getTubeCapacity());
    if (pkg === 'small_tube') {
      // The rate table covers up to MAX_SMALL_TUBES small tubes; any overflow
      // is billed as large tubes so it never collides with a lighter row.
      const small = Math.min(tubes, MAX_SMALL_TUBES);
      const overflow = tubes - small;
      const lines = [{ title: PKG_TUBE_S, quantity: small }];
      if (overflow > 0) lines.push({ title: PKG_TUBE_L, quantity: overflow });
      return { package: pkg, lines };
    }

    return { package: pkg, lines: [{ title: PKG_TUBE_L, quantity: tubes }] };
  };

  // On-page estimate for this print line (mirrors the delivery profile).
  const estimatePrintShipping = (plan) => {
    if (!plan || !plan.lines || plan.lines.length === 0) return null;
    let weight = 0;
    let price = 0;
    plan.lines.forEach((line) => {
      weight += (VARIANT_WEIGHTS[line.title] || 0) * line.quantity;
      price += (SHIP_EST[line.title] || 0) * line.quantity;
    });
    if (weight >= SHIP_EST.catchAllWeightLb) return SHIP_EST.catchAll;
    return price;
  };

  const findVariantByTitle = (variants, title) => {
    const want = (title || '').trim().toLowerCase();
    return (variants || []).find((variant) => (variant.title || '').trim().toLowerCase() === want) || null;
  };

  // Fallback: match by billing weight (variant weights come through in grams).
  const findVariantByWeight = (variants, title) => {
    const lb = VARIANT_WEIGHTS[title];
    if (!lb) return null;
    const wantGrams = lb * GRAMS_PER_LB;
    return (
      (variants || []).find((variant) => {
        const grams = Number(variant.weight || 0);
        return grams > 0 && Math.abs(grams - wantGrams) / wantGrams < 0.05;
      }) || null
    );
  };

  const pickFallbackSizeShippingVariant = (variants, pkg) => {
    if (!variants || variants.length === 0) return null;
    const sorted = variants.slice().sort((a, b) => Number(a.weight || 0) - Number(b.weight || 0));
    // Flat prints fall back to the lightest variant, tubes to the heaviest,
    // so a mismatch still collects an address and charges something sensible.
    return pkg === 'flat' ? sorted[0] : sorted[sorted.length - 1];
  };

  // Build the cart line items for the companion product.
  const buildPrintShippingItems = (variants, plan, parentTimestamp) => {
    if (!plan || !variants || variants.length === 0) return [];
    const items = [];
    plan.lines.forEach((line) => {
      if (!line.quantity || line.quantity < 1) return;
      const variant =
        findVariantByTitle(variants, line.title) ||
        findVariantByWeight(variants, line.title) ||
        pickFallbackSizeShippingVariant(variants, plan.package);
      if (!variant) return;
      items.push({
        id: variant.id,
        quantity: line.quantity,
        properties: {
          '_role': 'shipping_size',
          '_parent_timestamp': parentTimestamp,
          '_package': line.title,
        },
      });
    });
    return items;
  };

  if (getSizeShippingHandle()) {
    ensureSizeShippingVariants();
  }

  // Submit
  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const ownedFlow = printJobFlow();
    if (ownedFlow) {
      if (cartDrawer?.getAttribute?.('aria-busy') === 'true') { cartDrawer?.open?.(document.activeElement); return; }
      if (cartDrawer?.classList.contains('update-failed') && !ownedFlow.canRetry?.()) {
        cartDrawer?.open?.(document.activeElement);
        setErrorMessage('The cart could not be confirmed. Please contact us before trying again.');
        return;
      }
      setErrorMessage('');
      cartDrawer?.setPending?.(true);
      cartDrawer?.open?.(document.activeElement);
    }
    const invalidSelection = () => {
      if (ownedFlow) { cartDrawer?.setPending?.(false); cartDrawer?.close?.(); }
    };

    // Refresh known completed uploads before the page's existing validation.
    // Expired display receipts are not a request to upload the bytes again.
    try { await ownedFlow?.refresh?.(); }
    catch (error) {
      const retryable = ownedFlow?.canRetry?.() === true;
      const message = ownedFlow?.errorMessage?.(error) || 'The images could not be confirmed. Please check the upload selection.';
      cartDrawer?.setPending?.(false, { failed: !retryable, message });
      if (retryable) cartDrawer?.close?.();
      setErrorMessage(message);
      return;
    }

    // Validate all currently open/visible fields
    const { errors } = validateOpenFields();
    if (errors.length > 0) {
      invalidSelection();
      // Scroll to first error section (100px above)
      const first = errors
        .map((fs) => ({ fs, top: fs.getBoundingClientRect().top + window.scrollY }))
        .sort((a, b) => a.top - b.top)[0].fs;
      const targetY = Math.max(0, first.getBoundingClientRect().top + window.scrollY - 250);
      window.scrollTo({ top: targetY, behavior: 'smooth' });
      const focusTarget = first.querySelector('input[type="radio"], input, select, textarea');
      if (focusTarget) focusTarget.focus({ preventScroll: true });
      return;
    }

    const customValidation = getCustomSizeValidation({ showErrors: true, forceAll: true });
    if (customValidation.active && !customValidation.valid) {
      invalidSelection();
      const scrollTarget = customSizeContainer || customSizeFieldset;
      if (scrollTarget) {
        const targetY = Math.max(0, scrollTarget.getBoundingClientRect().top + window.scrollY - 250);
        window.scrollTo({ top: targetY, behavior: 'smooth' });
      }
      return;
    }

    // With Cart Transform API, we no longer need to find a variant by price.
    // We just pass the custom price and use the base variant ID.
    const HARD_LIMIT_DOLLARS = 2000;
    if (total > HARD_LIMIT_DOLLARS) {
      invalidSelection();
      setErrorMessage('Please contact us for single orders over $2000.');
      const target = errorEl || form;
      if (target && typeof target.scrollIntoView === 'function') {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      return;
    }

    if (ownedFlow) {
      setErrorMessage('');
      const result = await ownedFlow.submit();
      if (result?.accepted) {
        if (result.render) {
          try {
            await document.querySelector('cart-drawer-items').refreshOwnedCart(result.cart, result.render);
            if (!ownedFlow.reset()) throw new Error('Form reset unavailable');
            clearFormAndScrollTop();
            cartDrawer?.setPending?.(false);
          } catch (_) {
            cartDrawer?.setPending?.(false, { failed: true });
            setErrorMessage('The cart could not be confirmed. Please contact us before trying again.');
          }
          return;
        }
        if (!ownedFlow.reset()) throw new Error('Form reset unavailable');
        clearFormAndScrollTop();
        if (cartDrawer && typeof cartDrawer.renderContents === 'function') {
          // Fetch rendered sections after the verified native mutation. This
          // preserves the existing drawer and the in-memory shopper session.
          try {
            const response = await fetch(`${window.Shopify?.routes?.root || '/'}?sections=cart-drawer`, { credentials: 'same-origin' });
            if (!response.ok) throw new Error('Cart sections unavailable');
            const sections = await response.json();
            if (!sections['cart-drawer']) throw new Error('Cart sections unavailable');
            cartDrawer.renderContents({ sections });
            cartDrawer.setPending?.(false);
            const count = result.cart.items.reduce((sum, item) => sum + item.quantity, 0);
            const cartLink = document.getElementById('cart-icon-bubble');
            const badge = cartLink?.querySelector('.cart-button__number');
            if (badge) badge.textContent = String(count);
            if (cartLink) cartLink.setAttribute('aria-label', `Shopping cart with ${count} item${count === 1 ? '' : 's'}`);
          } catch (_) {
            window.location.href = '/cart';
          }
        } else {
          window.location.href = '/cart';
        }
      } else {
        const retryable = ownedFlow.canRetry?.() === true;
        const message = ownedFlow.errorMessage?.() || 'The cart could not be confirmed. Please contact us before trying again.';
        cartDrawer?.setPending?.(false, { failed: !retryable, message });
        if (retryable) cartDrawer?.close?.();
        setErrorMessage(message);
      }
      return;
    }

    // Use the variant ID from the hidden input on the form, or the global window var
    const baseVariantInput = form.querySelector('input[name="id"]');
    const baseVariantId = baseVariantInput ? parseInt(baseVariantInput.value, 10) : window.filmServiceBaseVariantId;

    if (!baseVariantId) {
      setErrorMessage('Something went wrong finding the base product. Please refresh the page or contact us.');
      const target = errorEl || form;
      if (target && typeof target.scrollIntoView === 'function') {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      return;
    }

    // --- Check if we need to add separate Return Shipping product ---
    // The group name in JSON is "Add Ons - Do you want your negatives shipped back to you?"
    // Liquid 'handle' filter usually converts this to "add-ons-do-you-want-your-negatives-shipped-back-to-you"
    const returnShippingRadio = Array.from(form.querySelectorAll('input[type="radio"]:checked')).find((r) =>
      r.name.includes('negatives-shipped-back')
    );

    const shippingId = window.globalReturnShippingVariantId || window.returnShippingVariantId;
    const selectedQty = Math.max(1, parseInt(qtyInput?.value || '1', 10) || 1);
    const fileCount = getUploadedFilesCount();

    // The cart quantity represents the 'Number of Copies'
    const finalQty = selectedQty;

    // The total physical items (for weight/shipping calculations)
    const totalPhysicalItems = selectedQty * fileCount;

    // The unit price of this line item needs to cover all uploaded files for 1 copy
    const customUnitPrice = total * fileCount;

    const itemsToAdd = [];

    // 1. Check if we need to add Return Shipping
    if (returnShippingRadio && (returnShippingRadio.value || '').toLowerCase() === 'yes' && shippingId) {
      try {
        const cartRes = await fetch('/cart.js');
        if (cartRes.ok) {
          const cart = await cartRes.json();
          const hasShipping = cart.items.some((item) => item.id === shippingId || item.variant_id === shippingId);

          if (!hasShipping) {
            // Get location from form
            const locationRadio = form.querySelector('input[name="location"]:checked');
            const locationValue = locationRadio ? locationRadio.value : null;

            const returnShippingProperties = { _role: 'return_shipping' };
            if (locationValue) {
              returnShippingProperties['Location'] = locationValue;
            }

            // console.log('Queuing Return Shipping product:', shippingId);
            itemsToAdd.push({
              id: parseInt(shippingId, 10),
              quantity: 1,
              properties: returnShippingProperties,
            });
          }
        }
      } catch (err) {
        console.error('Error checking cart for shipping item:', err);
      }
    }

    // 2. Add the Main Film Service Item
    const mainItem = {
      id: baseVariantId,
      quantity: finalQty,
      properties: {
        _custom_price_cents: Math.round(customUnitPrice * 100).toString(),
        // Add a fallback public property just in case Shopify strips hidden ones in Cart Transform
        _fallback_price_cents: Math.round(customUnitPrice * 100).toString()
      },
    };

    const normalizeUploadProperties = (properties) => {
      if (!properties) return;

      const uploadKeyPattern = /^upload your prints here!\s*\d+\s*:?\s*$/i;
      const uploadValues = [];

      Object.keys(properties).forEach((key) => {
        if (!uploadKeyPattern.test(key)) return;
        const val = properties[key];
        if (typeof val === 'string' && val.trim()) uploadValues.push(val.trim());
        delete properties[key];
      });

      if (uploadValues.length > 0) {
        const existing = properties.Files;
        const existingList =
          typeof existing === 'string' && existing.trim() ? existing.split(',').map(s => s.trim()) : [];
        const merged = Array.from(new Set([...existingList, ...uploadValues]));

        merged.forEach((url, index) => {
          properties[`Uploaded File ${index + 1}`] = url;
        });
        delete properties.Files;
      }
    };

    // Collect properties from fieldsets
    const serviceRadio = form.querySelector('input[name="service"]:checked');
    const isDarkroom = serviceRadio && serviceRadio.value === 'Darkroom Prints';

    form.querySelectorAll('fieldset').forEach((fs) => {
      // Skip hidden/unavailable fieldsets
      if (!isVisible(fs)) return;

      // 1. Radio properties
      if (fs.dataset.group === 'Add Ons') {
        const checkedRadios = fs.querySelectorAll('input[type="radio"]:checked');
        checkedRadios.forEach((radio) => {
          const val = (radio.value || '').trim();
          if (!val || val.toLowerCase() === 'no') return;

          let key = radio.name || 'Add On';
          key = key.replace(/^add-ons-/, '').replace(/-/g, ' ');
          key = key.replace(/\b\w/g, (c) => c.toUpperCase());

          mainItem.properties[key] = val;
        });
      } else {
        const checked = fs.querySelector('input[type="radio"]:checked');
        if (checked) mainItem.properties[fs.dataset.group] = checked.value;
      }

      // 2. Text/Select properties (e.g. Address fields)
      const addressParts = [];
      // Check if this is the specific Delivery Address group
      const isAddressGroup = fs.dataset.group === 'Delivery Address';

      fs
        .querySelectorAll('input[type="text"], input[type="email"], input[type="number"], input[type="hidden"], select, textarea')
        .forEach(
        (input) => {
          if (!input.name || !input.name.startsWith('properties[') || input.disabled) return;
          const match = input.name.match(/properties\[(.*?)\]/);
          // Only add if we have a key and a value
          if (match && match[1] && input.value.trim() !== '') {
            if (isAddressGroup) {
              addressParts.push(input.value.trim());
            } else {
              mainItem.properties[match[1]] = input.value.trim();
            }
          }
        }
      );

      if (isAddressGroup && addressParts.length > 0) {
        mainItem.properties['Delivery Address'] = addressParts.join(', ');
      }
    });

    if (customValidation.active && customValidation.valid) {
      mainItem.properties['Custom Width'] = `${customValidation.width}"`;
      mainItem.properties['Custom Height'] = `${customValidation.height}"`;
      mainItem.properties['Custom Size'] = `${customValidation.width}" × ${customValidation.height}"`;

      // Make the main "Sizes" property merchant-friendly.
      // In Admin/Orders, seeing "Sizes: Custom" alone is not useful; include the actual dimensions.
      if (typeof mainItem.properties['Sizes'] === 'string') {
        const sizesValue = mainItem.properties['Sizes'].trim();
        if (sizesValue.toLowerCase() === 'custom') {
          mainItem.properties['Sizes'] = `${customValidation.width}" × ${customValidation.height}" (Custom)`;
        }
      }
    }

    if (!isDarkroom) {
      // Look for uploady elements to add as property (fallback to ensure uploadly link gets added)
      const uploadlyHiddenInputs = document.querySelectorAll('input[type="hidden"]');
      uploadlyHiddenInputs.forEach((input) => {
        if (input.name && input.name.startsWith('properties[') && input.value && input.value.trim() !== '') {
          const match = input.name.match(/properties\[(.*?)\]/);
          if (match && match[1]) {
            // Only add if not already present to avoid overriding legitimate fieldset inputs
            if (!mainItem.properties[match[1]]) {
              mainItem.properties[match[1]] = input.value;
            }
          }
        }
      });

      // Also grab form properties from outside the fieldset (e.g. Uploady inputs appended to body)
      const extraUploadInputs = document.querySelectorAll(
        'input[type="hidden"][name*="properties"], input[type="text"][name*="properties"]'
      );
      extraUploadInputs.forEach((input) => {
        // Skip known properties that are not uploadly specific, avoid overriding things
        const nameStr = input.name.toLowerCase();
        if (
          nameStr.includes('[return delivery]') ||
          nameStr.includes('[turnaround]') ||
          nameStr.includes('[message]') ||
          nameStr.includes('[total price]') ||
          nameStr.includes('[_timestamp]')
        ) {
          return;
        }

        const match = input.name.match(/properties\[(.*?)\]/);
        if (match && match[1] && input.value && input.value.trim() !== '') {
          // Only add if not already present
          if (!mainItem.properties[match[1]]) {
            mainItem.properties[match[1]] = input.value;
          }
        }
      });
    }

    // Clean up Uploady/Uploadly-generated property keys/labels for Orders/Admin.
    normalizeUploadProperties(mainItem.properties);

    // Save address details to localStorage for convenience
    try {
      // Find all address inputs that have a value
      const addressInputs = form.querySelectorAll(
        'fieldset[data-group="Delivery Address"] input, fieldset[data-group="Delivery Address"] select'
      );
      const addressData = {};
      let hasAddress = false;
      addressInputs.forEach((input) => {
        if (!input.name || !input.name.includes('properties[')) return;
        const key = input.name.match(/properties\[(.*?)\]/)?.[1];
        if (key && input.value.trim()) {
          addressData[key] = input.value.trim();
          hasAddress = true;
        }
      });
      if (hasAddress) {
        localStorage.setItem('bellows_delivery_address', JSON.stringify(addressData));
      }
    } catch (e) {
      console.error('Error saving address', e);
    }

    // Add hidden flag for robust cart guard tracking
    if (returnShippingRadio && (returnShippingRadio.value || '').toLowerCase() === 'yes') {
      mainItem.properties['_return_shipping_required'] = 'true';
    }

    // Add special properties
    mainItem.properties['Total Price'] = `$${total.toFixed(2)}`;
    if (fileCount > 1) {
      mainItem.properties['Files Uploaded'] = String(fileCount);
    }
    mainItem.properties['_timestamp'] = Date.now();

    // 3. Add the Print Shipping companion item(s) (Film Printing only).
    // A $0 physical product whose variant weights drive the weight-based
    // shipping rate at checkout (and make checkout collect an address).
    // Pickup at checkout removes the charge automatically.
    let printShippingItems = [];
    const sizeShippingVariants = await ensureSizeShippingVariants();
    if (getSizeShippingHandle() && sizeShippingVariants.length > 0) {
      const printDims = getSelectedPrintDims(customValidation);
      const plan = planPrintShipping(printDims, totalPhysicalItems);
      printShippingItems = buildPrintShippingItems(sizeShippingVariants, plan, mainItem.properties['_timestamp']);
      if (plan) {
        mainItem.properties['_package'] = plan.lines.map((l) => `${l.quantity} × ${l.title}`).join(', ');
      }
    }

    itemsToAdd.push(mainItem);
    printShippingItems.forEach((item) => itemsToAdd.push(item));

    const resetButtonState = () => {
      submitBtns.forEach(btn => {
        btn.disabled = false;
        btn.removeAttribute('aria-disabled');
        btn.classList.remove('is-loading');
      });
    };

    const setLoadingState = () => {
      submitBtns.forEach(btn => {
        btn.disabled = true;
        btn.setAttribute('aria-disabled', 'true');
        btn.classList.add('is-loading');
      });
    };

    setLoadingState();

    try {
      if (window.CartDrawerAPI && typeof window.CartDrawerAPI.addToCart === 'function') {
        // Warning: CartDrawerAPI might not support bulk add easily if it expects FormData
        // We will fallback to standard fetch for bundled items to ensure atomicity
      }

      const endpoint =
        (window.Shopify && window.Shopify.routes && window.Shopify.routes.root + 'cart/add.js') || '/cart/add.js';

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({
          items: itemsToAdd,
          sections: 'cart-drawer,cart-icon-bubble',
          sections_url: window.location.pathname,
        }),
      });

      const data = await response.json();

      if (!response.ok || data.status === 'error' || data.description) {
        const message = data.description || data.message || 'Error adding to cart.';
        console.error('Add to cart error:', data);
        setErrorMessage(message);
        const target = errorEl || form;
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        resetButtonState();
        return;
      }

      // Clear and scroll on success
      clearFormAndScrollTop();

      if (cartDrawer && typeof cartDrawer.renderContents === 'function') {
        // Pass the data (which now includes 'sections') to the drawer to render
        cartDrawer.renderContents(data);

        // Trigger global update for other components (like header bubble) if needed
        if (window.publish && window.PUB_SUB_EVENTS) {
          // We can pass the same data, or minimal data. cart-items often refetches if needed.
          // But renderContents usually handles the drawer itself.
          window.publish(window.PUB_SUB_EVENTS.cartUpdate, { source: 'film-service', cartData: data });
        }
      } else {
        window.location.href = '/cart';
      }

      resetButtonState();
    } catch (err) {
      console.error(err);
      setErrorMessage('Unexpected error. Please contact us.');
      resetButtonState();
    }
  });

  // Init
  form.addEventListener('bfl:uploads-changed', () => calculateTotal());
  prefillAddressFields();
  applyConditions();
  updateDeliveryInfoVisibility();
  updateOrderSummaryVisibility();
  syncUploadlyFallbackVisibility();
  syncUploadlyStatusVisibility();
  monitorUploadyMount();

  // In theme preview / staging, app blocks can fail to mount immediately.
  // Re-check for a short period so the fallback button reliably appears.
  setTimeout(syncUploadlyFallbackVisibility, 300);
  setTimeout(syncUploadlyFallbackVisibility, 1200);
  setTimeout(syncUploadlyFallbackVisibility, 2500);

  if (uploadlyFallbackButton) {
    let fallbackRetryCount = 0;
    uploadlyFallbackButton.addEventListener('click', () => {
      // Re-check immediately in case the widget mounted after our last poll.
      syncUploadlyFallbackVisibility();
      if (hasUploadyWidgetMounted()) {
        openUploadlyFromFallback();
        return;
      }

      if (uploadlyHasAppBlock) {
        // Live context: re-run the in-page recovery. After a couple of failed
        // retries, escalate the button to a one-time cache-busting reload.
        if (fallbackRetryCount >= 2) {
          uploadlyFallbackButton.textContent = 'Reloading…';
          cacheBustingReload(true);
          return;
        }
        fallbackRetryCount += 1;
        uploadlyFallbackButton.disabled = true;
        uploadlyFallbackButton.textContent = 'Retrying…';
        if (uploadlyStatusEl) {
          uploadlyStatusEl.textContent = 'Retrying…';
          uploadlyStatusEl.style.display = '';
        }
        if (typeof triggerUploadlyRecovery === 'function') triggerUploadlyRecovery();
        // Re-check after a short window; restore the control if still unmounted.
        setTimeout(() => {
          if (hasUploadyWidgetMounted()) {
            uploadlyRecoveryFailed = false;
            syncUploadlyStatusVisibility();
            syncUploadlyFallbackVisibility();
            return;
          }
          uploadlyFallbackButton.disabled = false;
          uploadlyFallbackButton.textContent =
            fallbackRetryCount >= 2 ? 'Reload page' : 'Retry upload tool';
          if (uploadlyStatusEl) uploadlyStatusEl.textContent = "Upload tool didn't load.";
        }, 6000);
        return;
      }

      // Non-app-block context (e.g. preview without app block): open whatever
      // interactive control exists, or surface a clear message.
      const opened = openUploadlyFromFallback();
      if (!opened) {
        setErrorMessage(
          'Upload tool did not load in this preview. Please refresh preview or open this theme in the customizer/live view.'
        );
      }
    });
  }

  // Add an observer to clear Upload error if hidden inputs are added by Uploadly, and to re-trigger total calculation
  const uploadFs = form.querySelector('fieldset[data-group="Upload"]');
  if (uploadFs) {
    let checkTimeout = null;
    let lastKnownFileCount = getActualFilesCount();

    const observer = new MutationObserver((mutations) => {
      let shouldCheck = false;
      for (const mutation of mutations) {
        if (mutation.addedNodes.length > 0 || mutation.type === 'attributes') {
          shouldCheck = true;
          break;
        }
      }
      if (shouldCheck) {
        if (checkTimeout) clearTimeout(checkTimeout);
        checkTimeout = setTimeout(() => {
          const currentCount = getActualFilesCount();

          const uploadInputs = Array.from(document.querySelectorAll('input[name*="properties"]')).filter((el) => {
            const nameStr = el.name.toLowerCase();
            if (
              nameStr.includes('[return delivery]') ||
              nameStr.includes('[turnaround]') ||
              nameStr.includes('[message]') ||
              nameStr.includes('[total price]') ||
              nameStr.includes('[_timestamp]')
            ) {
              return false;
            }
            return true;
          });

          const uploadlyItems = document.querySelectorAll(
            '.uploadly-item, .uploadly-file, .uploadly-list-item, .uploadly-preview, .uploady-item, .uploady-list-item, .uploady-preview, [data-uploadly-id], [class*="uploadly-"], [class*="uploady-"]'
          );
          const hasUploadedFile =
            uploadInputs.some((el) => el.value && el.value.trim() !== '') || uploadlyItems.length > 0;

          // As a fallback, check if there's any file input with a file selected
          const fileInputs = Array.from(document.querySelectorAll('input[type="file"]'));
          const hasNativeFile = fileInputs.some((el) => el.files && el.files.length > 0);

          const ownedUploads = printJobFlow()?.snapshot();
          const uploadReady = ownedUploads
            ? !ownedUploads.pending && !ownedUploads.failed && currentCount > 0
            : hasUploadedFile || hasNativeFile || currentCount > 0;
          if (uploadReady) {
            uploadFs.classList.remove('rolls-form-card--error');
            const errorMsg = uploadFs.querySelector('.upload-error-msg');
            if (errorMsg) errorMsg.remove();
          }

          if (currentCount !== lastKnownFileCount) {
            lastKnownFileCount = currentCount;
            calculateTotal();
          }
          syncUploadlyFallbackVisibility();
          syncUploadlyStatusVisibility();
        }, 250);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['value'] });
  }
});
