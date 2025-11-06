document.addEventListener('DOMContentLoaded', () => {
  const form = document.querySelector('#film-service-form');
  if (!form) return;

  const totalDisplay = document.querySelector('#film-total-display');
  const basePrice = Number(document.querySelector('#base-price').dataset.base);
  const variantInput = form.querySelector('input[name="id"]');
  const submitBtn = form.querySelector('button[type="submit"]');
  const serviceRadios = form.querySelectorAll('input[name="service"]');
  const serviceBlocks = form.querySelectorAll('.service-groups-wrapper');
  let total = basePrice;

  // Hide all service groups initially
  serviceBlocks.forEach((block) => (block.style.display = 'none'));

  // Utility: normalize keys/values so JSON keys like "Film Format", "film_format" match radio.name "film-format"
  const normKey = (s) =>
    (s || '')
      .toString()
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '-') // spaces -> hyphen
      .replace(/_+/g, '-'); // underscores -> hyphen

  const normVal = (s) => (s || '').toString().trim().toLowerCase();

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
      if (activeBlock) activeBlock.style.display = 'block';

      // Uncheck radios in all non-active service blocks to prevent stale selections affecting totals
      serviceBlocks.forEach((block) => {
        if (block !== activeBlock) {
          block.querySelectorAll('input[type="radio"]:checked').forEach((input) => {
            input.checked = false;
          });
        }
      });

      applyConditions();
    });
  });

  // // Optionally auto-select first service block (keep if you want)
  // if (serviceRadios.length > 0 && !form.querySelector('input[name="service"]:checked')) {
  //   serviceRadios[0].checked = true;
  //   serviceRadios[0].dispatchEvent(new Event('change'));
  // }

  // --- Total calc ---
  function calculateTotal() {
    total = basePrice;
    form.querySelectorAll('input[type="radio"]:checked').forEach((input) => {
      total += Number(input.dataset.price || 0);
    });
    totalDisplay.textContent = `Total: $${total.toFixed(2)}`;
  }

  // --- Conditions (show-if + price-overrides) with normalized keys ---
  function applyConditions() {
    // Build selected map with multiple aliases for robustness
    const selected = {};
    form.querySelectorAll('input[type="radio"]:checked').forEach((r) => {
      const keyHyphen = normKey(r.name); // e.g., film-format
      const keyUnder = keyHyphen.replace(/-/g, '_'); // e.g., film_format
      selected[keyHyphen] = r.value;
      selected[keyUnder] = r.value;
    });

    const hasLocation = !!selected['location'];
    const hasService = !!selected['service'];

    // Enforce required picks
    if (submitBtn) submitBtn.disabled = !(hasLocation && hasService);

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

      const showIf = parseJSON(showIfRaw);
      const priceOverrides = parseJSON(priceOverridesRaw);

      // --- Visibility
      let shouldShow = true;
      if (showIf) {
        // Require ALL show-if groups to match (change to .some if you want "any")
        shouldShow = Object.entries(showIf).every(([k, allowed]) => {
          const key = normKey(k); // normalize group key
          const sel = selected[key] || selected[key.replace(/-/g, '_')];
          if (!Array.isArray(allowed) || !allowed.length) return true;
          const allowedNorm = allowed.map(normVal);
          return sel ? allowedNorm.includes(normVal(sel)) : false;
        });
      }

      // Hide/show option; uncheck if it becomes hidden
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

      // Update visible price text
      const priceEl = label.querySelector('.opt-price');
      if (priceEl) priceEl.textContent = newPrice > 0 ? `$${newPrice}` : 'Free';
    });

    calculateTotal();
  }

  // React to any radio change
  form.addEventListener('change', (e) => {
    if (e.target.matches('input[type="radio"]')) applyConditions();
  });

  // Match variant by price
  function findVariantByPrice(priceDollars) {
    const cents = Math.round(priceDollars * 100);
    return window.productVariants.find((v) => Number(v.price) === cents);
  }

  // Submit
  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const location = form.querySelector('input[name="location"]:checked');
    const service = form.querySelector('input[name="service"]:checked');
    if (!location || !service) {
      alert('Please choose both a location and a service before continuing.');
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
    fd.append('quantity', 1);

    // --- Append selected options ---
    form.querySelectorAll('fieldset').forEach((fs) => {
      const checked = fs.querySelector('input[type="radio"]:checked');
      if (checked) fd.append(`properties[${fs.dataset.group}]`, checked.value);
    });

    // --- Total price summary ---
    fd.append('properties[Total Price]', `$${total.toFixed(2)}`);

    // ✅ UNIQUE TIMESTAMP to prevent Shopify from merging identical line items
    fd.append('properties[_timestamp]', Date.now());

    try {
      const res = await fetch('/cart/add.js', { method: 'POST', body: fd });
      if (!res.ok) throw new Error(await res.text());
      window.location.href = '/cart';
    } catch (err) {
      console.error(err);
      alert('Error adding to cart');
    }
  });

  // Init
  applyConditions();
});
