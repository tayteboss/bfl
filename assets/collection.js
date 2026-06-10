// Collection filters modal behavior
// Handles opening/closing the filters modal and a simple loading state on submit.

(function () {
  if (typeof document === 'undefined') return;

  function initCollectionFilters() {
    const triggers = document.querySelectorAll('[data-filters-open]');
    if (!triggers.length) return;

    triggers.forEach((trigger) => {
      const controlsId = trigger.getAttribute('aria-controls');
      if (!controlsId) return;

      const modal = document.getElementById(controlsId);
      if (!modal) return;

      // Move modal to the body so it sits above header / other sections in the stacking context
      if (!modal.dataset.portalized) {
        document.body.appendChild(modal);
        modal.dataset.portalized = 'true';
      }

      const dialog = modal.querySelector('.filters-modal__dialog');
      const closeButtons = modal.querySelectorAll('[data-filters-close]');
      const form = modal.querySelector('[data-filters-form]');

      function openModal() {
        modal.setAttribute('aria-hidden', 'false');
        modal.classList.add('filters-modal--open');
        document.body.classList.add('filters-modal-open');

        // Move focus into the dialog for accessibility
        const focusTarget =
          modal.querySelector('[data-filters-form]') ||
          modal.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
        if (focusTarget && typeof focusTarget.focus === 'function') {
          focusTarget.focus();
        }
      }

      function closeModal() {
        modal.setAttribute('aria-hidden', 'true');
        modal.classList.remove('filters-modal--open');
        document.body.classList.remove('filters-modal-open');
        trigger.focus();
      }

      // Open on trigger click
      trigger.addEventListener('click', (event) => {
        event.preventDefault();
        openModal();
      });

      // Close on dedicated close buttons
      closeButtons.forEach((btn) => {
        btn.addEventListener('click', (event) => {
          event.preventDefault();
          closeModal();
        });
      });

      // Close when clicking outside the dialog
      modal.addEventListener('click', (event) => {
        if (!dialog) return;
        if (!dialog.contains(event.target)) {
          closeModal();
        }
      });

      // Close on Escape key when modal is open
      modal.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' || event.key === 'Esc') {
          if (modal.getAttribute('aria-hidden') === 'false') {
            event.stopPropagation();
            closeModal();
          }
        }
      });

      // Loading state on form submit – uses data-filters-loading attribute
      if (form) {
        form.addEventListener('submit', () => {
          trigger.setAttribute('data-filters-loading', 'true');
        });

        // Initialize filter button active states and clear (×) behavior
        const filterItems = form.querySelectorAll('.filter-group__item');
        filterItems.forEach((item) => {
          const input = item.querySelector('input.filter-option');
          if (!input) return;

          // Initial sync from checked state
          if (input.checked) {
            item.classList.add('is-active');
          }

          // Toggle visual active state when checkbox changes
          input.addEventListener('change', () => {
            if (input.checked) {
              item.classList.add('is-active');
            } else {
              item.classList.remove('is-active');
            }
          });

          // Allow clicking the × to clear without submitting
          const remove = item.querySelector('.active-filter-remove');
          if (remove) {
            remove.addEventListener('click', (event) => {
              event.preventDefault();
              event.stopPropagation();
              input.checked = false;
              item.classList.remove('is-active');
            });
          }
        });
      }
    });
  }

  function initCollectionLoadMore() {
    const loadMoreLinks = document.querySelectorAll('[data-collection-load-more]');
    if (!loadMoreLinks.length) return;

    loadMoreLinks.forEach((link) => {
      link.addEventListener('click', async (event) => {
        event.preventDefault();

        const button = event.currentTarget;
        if (!button || button.dataset.loading === 'true') return;

        const url = button.href;
        if (!url) return;

        button.dataset.loading = 'true';

        try {
          const response = await fetch(url, {
            headers: {
              'X-Requested-With': 'XMLHttpRequest',
            },
          });

          if (!response.ok) {
            throw new Error('Failed to load more products');
          }

          const html = await response.text();
          const parser = new DOMParser();
          const doc = parser.parseFromString(html, 'text/html');

          const currentSection = button.closest('[data-collection-section]') || document;
          const sectionId = currentSection.getAttribute('data-section-id');

          let newRoot = doc;
          if (sectionId) {
            const matchedSection = doc.querySelector(`[data-collection-section][data-section-id="${sectionId}"]`);
            if (matchedSection) {
              newRoot = matchedSection;
            }
          }

          const currentList = currentSection.querySelector('[data-collection-list]');
          const newList = newRoot.querySelector('[data-collection-list]');

          if (currentList && newList) {
            Array.from(newList.children).forEach((child) => {
              currentList.appendChild(child);
            });
          }

          const newLoadMore = newRoot.querySelector('[data-collection-load-more]');
          const paginationWrapper = button.closest('.pagination-button') || button.parentElement;

          if (newLoadMore && paginationWrapper) {
            button.href = newLoadMore.href;
            button.dataset.loading = 'false';
          } else if (paginationWrapper) {
            paginationWrapper.remove();
          }
        } catch (error) {
          console.error('Error loading more products', error);
          // Fallback to normal navigation if AJAX fails
          window.location.href = url;
        }
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initCollectionFilters);
    document.addEventListener('DOMContentLoaded', initCollectionLoadMore);
  } else {
    initCollectionFilters();
    initCollectionLoadMore();
  }
})();
