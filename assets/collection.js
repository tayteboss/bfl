function loadMoreOnce(trigger) {
  if (!trigger) return Promise.resolve(false);
  const sectionEl = document.querySelector('[data-collection-section]');
  if (!sectionEl) return Promise.resolve(false);
  const sectionId = sectionEl.getAttribute('data-section-id');
  const listEl = sectionEl.querySelector('[data-collection-list]');
  const buttonWrapper = trigger.closest('.pagination-button');
  if (!sectionId || !listEl) return Promise.resolve(false);

  const url = new URL(trigger.getAttribute('href'), window.location.origin);
  url.searchParams.set('section_id', sectionId);

  trigger.setAttribute('aria-busy', 'true');
  if (buttonWrapper) buttonWrapper.classList.add('is-loading');

  return fetch(url.toString())
    .then((r) => r.text())
    .then((html) => {
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      const nextSection = doc.querySelector(`[data-collection-section][data-section-id="${sectionId}"]`);
      if (!nextSection) return false;
      const nextList = nextSection.querySelector('[data-collection-list]');
      const nextButton = nextSection.querySelector('[data-collection-load-more]');

      if (nextList) {
        listEl.insertAdjacentHTML('beforeend', nextList.innerHTML);
        const emptyMsg = listEl.querySelector('.collection-empty-message');
        if (emptyMsg) emptyMsg.remove();
      }

      if (nextButton) {
        trigger.setAttribute('href', nextButton.getAttribute('href'));
        trigger.removeAttribute('aria-busy');
        if (buttonWrapper) buttonWrapper.classList.remove('is-loading');
        return true;
      } else {
        if (buttonWrapper) buttonWrapper.remove();
        return false;
      }
    })
    .catch(() => {
      trigger.removeAttribute('aria-busy');
      if (buttonWrapper) buttonWrapper.classList.remove('is-loading');
      return false;
    });
}

document.addEventListener('click', function (e) {
  const trigger = e.target.closest('[data-collection-load-more]');
  if (!trigger) return;
  e.preventDefault();
  if (trigger.getAttribute('aria-busy') === 'true') return;
  loadMoreOnce(trigger);
});

// Auto-top-up disabled - pagination now handles exactly 12 products per page
// document.addEventListener('DOMContentLoaded', function () {
//   const sectionEl = document.querySelector('[data-collection-section]');
//   if (!sectionEl) return;
//   const handle = sectionEl.getAttribute('data-collection-handle');
//   const listEl = sectionEl.querySelector('[data-collection-list]');
//   if (!listEl) return;
//   // Only auto-top-up on the "all" collection
//   if (handle !== 'all') return;

//   const MIN_VISIBLE = 12;
//   let safetyCounter = 0;

//   function countVisibleCards() {
//     return listEl.querySelectorAll('.product-card').length;
//   }

//   function topUpIfNeeded() {
//     if (countVisibleCards() >= MIN_VISIBLE) return;
//     const trigger = document.querySelector('[data-collection-load-more]');
//     if (!trigger) return;
//     if (safetyCounter >= 5) return; // prevent runaway
//     safetyCounter += 1;
//     loadMoreOnce(trigger).then((hasMore) => {
//       // Defer to allow DOM to update
//       requestAnimationFrame(() => {
//         if (countVisibleCards() < MIN_VISIBLE && hasMore) {
//           topUpIfNeeded();
//         }
//       });
//     });
//   }

//   topUpIfNeeded();
// });
