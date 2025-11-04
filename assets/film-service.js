(function () {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const form = document.getElementById('film-service-form');
  if (!form) return;

  const totalEl = document.getElementById('film-total');
  const submitBtn = document.getElementById('film-submit');
  const propService = document.getElementById('prop-service');
  const propTotal = document.getElementById('prop-total');

  const currency = totalEl?.dataset.currencySymbol || '$';

  let activeServiceId = null;
  let serviceBase = 0;

  // Convenience getters
  const getServiceBlocks = () => $$('#service-groups .service-groups-block');
  const getActiveBlock = () => $(`#service-groups .service-groups-block[data-for-service="${activeServiceId}"]`);
  const money = (n) => `${currency}${(Math.max(0, Number(n) || 0)).toFixed(2)}`;

  // Reset groups UI
  function resetGroups(block) {
    if (!block) return;
    $$('input', block).forEach((inp) => {
      if (inp.type === 'radio' || inp.type === 'checkbox') {
        inp.checked = false;
        inp.disabled = false;
        inp.closest('label')?.classList.remove('disabled');
      }
    });
  }

  // Parse JSON safely from data-conditions
  function getConditions(input) {
    const raw = input.getAttribute('data-conditions') || '{}';
    try {
      return JSON.parse(raw);
    } catch (e) {
      return {};
    }
  }

  // Get current selection for a given group title (string)
  function getSelection(groupTitle) {
    const block = getActiveBlock();
    if (!block) return null;
    // radios
    const checkedRadio = block.querySelector(`.option-group[data-group-title="${CSS.escape(groupTitle)}"] input[type="radio"]:checked`);
    if (checkedRadio) return { type: 'radio', input: checkedRadio, value: checkedRadio.value };
    // checkboxes
    const checkedBoxes = block.querySelectorAll(`.option-group[data-group-title="${CSS.escape(groupTitle)}"] input[type="checkbox"]:checked`);
    if (checkedBoxes.length) return { type: 'checkbox', inputs: Array.from(checkedBoxes), values: Array.from(checkedBoxes).map(i => i.value) };
    return null;
  }

  // Compute total with conditional pricing rules
  function computeTotal() {
    let total = Number(serviceBase) || 0;

    const block = getActiveBlock();
    if (!block) return total;

    // Gather selected inputs (radios + checkboxes)
    const selectedInputs = [
      ...block.querySelectorAll('input[type="radio"]:checked'),
      ...block.querySelectorAll('input[type="checkbox"]:checked')
    ];

    // Pull selected "Format" for conditional rules (adjust names if you use different group titles)
    const formatSel = getSelection('Film Development Format');
    const selectedFormat = formatSel && formatSel.value ? formatSel.value : null;

    // Walk each selected option and sum price, applying conditions
    selectedInputs.forEach((inp) => {
      const basePrice = Number(inp.dataset.price || 0);
      const cond = getConditions(inp);

      let add = basePrice;

      // Example conditional schema you can store in option.conditions:
      // {
      //   "onlyFormats": ["35mm"],                 // show/enable only for these formats
      //   "notFormats": ["120mm"],                 // disable for these formats
      //   "altPriceByFormat": { "120mm": 3, "8x10 Sheet": 3 },  // override base price per format
      //   "requiresService": ["Develop & Scan"],   // only valid for listed services
      //   "incompatibleWith": { "group": "Border Options", "options": ["Overscan (sprockets - 35mm only)"] }
      //   // You can expand this as needed
      // }

      // altPriceByFormat overrides base
      if (cond.altPriceByFormat && selectedFormat && cond.altPriceByFormat[selectedFormat] != null) {
        add = Number(cond.altPriceByFormat[selectedFormat]);
      }

      // Example: B&W only valid for some formats with extra +2 base
      // This can be represented as altPriceByFormat or as a simple surcharge map:
      // { "surchargeByFormat": {"120mm": 2, "8x10 Sheet": 2} }
      if (cond.surchargeByFormat && selectedFormat && cond.surchargeByFormat[selectedFormat] != null) {
        add += Number(cond.surchargeByFormat[selectedFormat]);
      }

      total += add;
    });

    return total;
  }

  // Enable/disable options based on rules + current selections
  function enforceRules() {
    const block = getActiveBlock();
    if (!block) return;

    const formatSel = getSelection('Film Development Format');
    const selectedFormat = formatSel && formatSel.value ? formatSel.value : null;

    const chosenService = propService.value || '';

    // Iterate all inputs in active block
    $$('input[type="radio"], input[type="checkbox"]', block).forEach((inp) => {
      const cond = getConditions(inp);
      let disable = false;

      // onlyFormats / notFormats
      if (cond.onlyFormats && selectedFormat && !cond.onlyFormats.includes(selectedFormat)) {
        disable = true;
      }
      if (cond.notFormats && selectedFormat && cond.notFormats.includes(selectedFormat)) {
        disable = true;
      }

      // requiresService
      if (cond.requiresService && chosenService && !cond.requiresService.includes(chosenService)) {
        disable = true;
      }

      // If disabling, also uncheck
      const label = inp.closest('label');
      if (disable) {
        inp.checked = false;
        inp.disabled = true;
        label && label.classList.add('disabled');
      } else {
        inp.disabled = false;
        label && label.classList.remove('disabled');
      }
    });

    // Example: Show/hide dependent groups — e.g., Printing → Copies
    const printing = getSelection('Do You Need Printing?');
    const copiesGroup = block.querySelector(`.option-group[data-group-title="Copies"]`);
    if (copiesGroup) {
      if (printing && printing.value === 'Yes') {
        copiesGroup.hidden = false;
      } else {
        // Uncheck any prior copies choice if hiding
        $$('input', copiesGroup).forEach(i => (i.checked = false));
        copiesGroup.hidden = true;
      }
    }
  }

  // Update UI total + hidden property
  function updateTotals() {
    const total = computeTotal();
    if (totalEl) totalEl.textContent = money(total);
    if (propTotal) propTotal.value = money(total);
    submitBtn.disabled = !activeServiceId; // require a service to be selected
  }

  // When service changes, toggle blocks
  function onServiceChange(radio) {
    activeServiceId = radio.getAttribute('data-service-id');
    serviceBase = Number(radio.getAttribute('data-service-base') || 0);
    propService.value = radio.value;

    // Hide all, show chosen
    getServiceBlocks().forEach((blk) => {
      blk.hidden = blk.getAttribute('data-for-service') !== activeServiceId;
    });

    // Reset the newly active groups
    const blk = getActiveBlock();
    resetGroups(blk);

    // Initial state for dependent groups (e.g., Copies hidden until "Printing: Yes")
    if (blk) {
      const copiesGroup = blk.querySelector(`.option-group[data-group-title="Copies"]`);
      if (copiesGroup) copiesGroup.hidden = true;
    }

    enforceRules();
    updateTotals();
  }

  // Event wiring
  form.addEventListener('change', (e) => {
    const t = e.target;
    if (t.name === 'service_choice' && t.checked) {
      onServiceChange(t);
      return;
    }

    if (!activeServiceId) return;

    // Any change inside the active service block:
    const blk = getActiveBlock();
    if (blk && blk.contains(t)) {
      enforceRules();
      updateTotals();
    }
  });

  // Disable submit until a service is picked
  submitBtn.disabled = true;
})();
