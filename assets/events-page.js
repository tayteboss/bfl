document.addEventListener('click', function (e) {
  const loadMore = e.target.closest('[data-events-load-more]');
  if (!loadMore) return;

  e.preventDefault();
  if (loadMore.getAttribute('aria-busy') === 'true') return;
  const url = new URL(loadMore.getAttribute('href'), window.location.origin);

  const sectionEl = document.querySelector('[data-events-collection]');
  if (!sectionEl) return;
  const sectionId = sectionEl.getAttribute('data-section-id');
  if (!sectionId) return;

  const upContainer = sectionEl.querySelector('[data-events-group="upcoming"]');
  const pastContainer = sectionEl.querySelector('[data-events-group="past"]');
  const buttonWrapper = loadMore.closest('.events-pagination-button');

  // Request next page markup for this section only
  url.searchParams.set('section_id', sectionId);

  loadMore.setAttribute('aria-busy', 'true');
  if (buttonWrapper) buttonWrapper.classList.add('is-loading');

  fetch(url.toString())
    .then((r) => r.text())
    .then((html) => {
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      const nextSection = doc.querySelector(`[data-events-collection][data-section-id="${sectionId}"]`);
      if (!nextSection) return;

      const nextUpcoming = nextSection.querySelector('[data-events-group="upcoming"]');
      const nextPast = nextSection.querySelector('[data-events-group="past"]');
      const nextButton = nextSection.querySelector('[data-events-load-more]');

      if (nextUpcoming && upContainer) {
        upContainer.insertAdjacentHTML('beforeend', nextUpcoming.innerHTML);
      }
      if (nextPast && pastContainer) {
        pastContainer.insertAdjacentHTML('beforeend', nextPast.innerHTML);
      }

      if (nextButton) {
        loadMore.setAttribute('href', nextButton.getAttribute('href'));
        loadMore.removeAttribute('aria-busy');
        if (buttonWrapper) buttonWrapper.classList.remove('is-loading');
      } else {
        // No more pages
        const wrapper = loadMore.closest('.events-pagination-button');
        if (wrapper) wrapper.remove();
      }
    })
    .catch(() => {
      loadMore.removeAttribute('aria-busy');
      if (buttonWrapper) buttonWrapper.classList.remove('is-loading');
    });
});
