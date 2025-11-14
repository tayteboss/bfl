(function () {
  function createTableElement(tableDef) {
    const table = document.createElement('table');
    table.className = 'service-table';

    if (Array.isArray(tableDef.headings) && tableDef.headings.length > 0) {
      const thead = document.createElement('thead');
      const tr = document.createElement('tr');
      tableDef.headings.forEach((heading) => {
        const th = document.createElement('th');
        th.textContent = String(heading);
        tr.appendChild(th);
      });
      thead.appendChild(tr);
      table.appendChild(thead);
    }

    if (Array.isArray(tableDef.rows)) {
      const tbody = document.createElement('tbody');
      tableDef.rows.forEach((row) => {
        const tr = document.createElement('tr');
        row.forEach((cell) => {
          const td = document.createElement('td');
          // Support object cells with { value, badge: { color, text } }
          if (cell && typeof cell === 'object') {
            const cellValue = 'value' in cell ? cell.value : '';
            if (cellValue != null && cellValue !== undefined) {
              td.appendChild(document.createTextNode(String(cellValue)));
            }
            const badge = cell.badge;
            if (badge && (badge.text != null || badge.color != null)) {
              const badgeEl = document.createElement('span');
              badgeEl.className = 'product-badge product-badge--table';
              if (badge.text != null) {
                badgeEl.textContent = String(badge.text);
              }
              if (badge.color) {
                badgeEl.style.backgroundColor = String(badge.color);
              }
              td.appendChild(badgeEl);
            }
          } else {
            td.textContent = String(cell);
          }
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
    }

    return table;
  }

  function renderServiceTables(data) {
    const mapping = Array.isArray(data.serviceToTable) ? data.serviceToTable : [];
    const tablesById = Object.create(null);
    if (Array.isArray(data.tables)) {
      data.tables.forEach((t) => {
        if (t && t.id) tablesById[t.id] = t;
      });
    }

    document.querySelectorAll('.service-card').forEach((sectionEl) => {
      if (sectionEl.dataset.tableRendered === 'true') return;
      const anchorId = sectionEl.getAttribute('id');
      if (!anchorId) return;
      const mappingEntry = mapping.find((m) => m.anchor_id === anchorId);
      if (!mappingEntry) return;
      const tableDef = tablesById[mappingEntry.table_id];
      if (!tableDef) return;

      // Create wrapper and inner scroller
      const wrapper = document.createElement('div');
      wrapper.className = 'service-card__table-wrapper';
      const scroller = document.createElement('div');
      scroller.className = 'service-card__table-scroller';

      const figure = document.createElement('figure');
      figure.className = 'service-card__table-figure';

      // Table
      figure.appendChild(createTableElement(tableDef));

      // Caption under table
      if (tableDef.caption) {
        const figcaption = document.createElement('figcaption');
        figcaption.className = 'service-card__table-caption type-p-small';
        figcaption.textContent = String(tableDef.caption);
        figure.appendChild(figcaption);
      }
      // Footer badge key under caption
      if (Array.isArray(tableDef.footerBadgeKey) && tableDef.footerBadgeKey.length > 0) {
        const keyWrapper = document.createElement('div');
        keyWrapper.className = 'service-card__key';
        tableDef.footerBadgeKey.forEach((item) => {
          if (!item) return;
          const badgeEl = document.createElement('span');
          badgeEl.className = 'service-card__key-badge product-badge product-badge--table-key';
          if (item.text != null) {
            badgeEl.textContent = String(item.text);
          }
          if (item.color) {
            badgeEl.style.backgroundColor = String(item.color);
          }
          keyWrapper.appendChild(badgeEl);
        });
        figure.appendChild(keyWrapper);
      }

      scroller.appendChild(figure);
      wrapper.appendChild(scroller);

      const grid = sectionEl.querySelector('.layout-grid');
      if (!grid) return;
      const buttonWrapper = grid.querySelector('.service-card__button-wrapper');
      if (buttonWrapper) {
        grid.insertBefore(wrapper, buttonWrapper);
      } else {
        grid.appendChild(wrapper);
      }

      // Gradient visibility based on scroll position
      function updateGradient() {
        const hasOverflowRight = scroller.scrollWidth - scroller.clientWidth - scroller.scrollLeft > 1;
        if (hasOverflowRight) {
          wrapper.classList.add('show-right-gradient');
        } else {
          wrapper.classList.remove('show-right-gradient');
        }
      }

      scroller.addEventListener('scroll', updateGradient, { passive: true });
      window.addEventListener('resize', updateGradient, { passive: true });
      // run initially after frame to allow layout
      requestAnimationFrame(updateGradient);
      sectionEl.dataset.tableRendered = 'true';
    });
  }

  function init() {
    const jsonUrlEl = document.querySelector('[data-services-tables-json]');
    const jsonUrl = jsonUrlEl ? jsonUrlEl.getAttribute('data-services-tables-json') : null;

    // Try to resolve relative to this script src as a fallback
    let derivedFromScript = null;
    try {
      const currentScript =
        document.currentScript || Array.from(document.scripts).find((s) => /services-tables\.js/.test(s.src));
      if (currentScript && currentScript.src) {
        const urlObj = new URL(currentScript.src, window.location.origin);
        urlObj.pathname = urlObj.pathname.replace(/services-tables\.js$/, 'services-tables.json');
        derivedFromScript = urlObj.toString();
      }
    } catch (_) {}

    const url =
      jsonUrl ||
      derivedFromScript ||
      (window.Shopify && window.Shopify.assetUrl ? window.Shopify.assetUrl('services-tables.json') : null);

    if (!url) return;

    fetch(url, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data) renderServiceTables(data);
      })
      .catch(() => {});
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
