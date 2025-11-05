document.addEventListener('click', function (e) {
  const loadMore = e.target.closest('[data-gear-load-more]');
  if (!loadMore) return;

  e.preventDefault();
  if (loadMore.getAttribute('aria-busy') === 'true') return;

  const listEl = document.querySelector('[data-gear-list]');
  if (!listEl) return;

  const buttonWrapper = loadMore.closest('.pagination-button');
  const allItems = listEl.querySelectorAll('[data-gear-item]');
  const hiddenItems = listEl.querySelectorAll('[data-gear-item].gear-card--hidden');
  
  if (hiddenItems.length === 0) {
    if (buttonWrapper) buttonWrapper.remove();
    return;
  }

  loadMore.setAttribute('aria-busy', 'true');
  if (buttonWrapper) buttonWrapper.classList.add('is-loading');

  // Show next 5 items
  const itemsToShow = Math.min(5, hiddenItems.length);
  for (let i = 0; i < itemsToShow; i++) {
    hiddenItems[i].classList.remove('gear-card--hidden');
  }

  // Remove button if all items are now visible
  const remainingHidden = listEl.querySelectorAll('[data-gear-item].gear-card--hidden');
  if (remainingHidden.length === 0 && buttonWrapper) {
    buttonWrapper.remove();
  }

  loadMore.removeAttribute('aria-busy');
  if (buttonWrapper) buttonWrapper.classList.remove('is-loading');
});

