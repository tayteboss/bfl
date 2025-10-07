document.addEventListener('click', function (e) {
  const trigger = e.target.closest('[data-collection-load-more]');
  if (!trigger) return;

  e.preventDefault();
  if (trigger.getAttribute('aria-busy') === 'true') return;
  const url = new URL(trigger.getAttribute('href'), window.location.origin);

  const sectionEl = document.querySelector('[data-collection-section]');
  if (!sectionEl) return;
  const sectionId = sectionEl.getAttribute('data-section-id');
  const listEl = sectionEl.querySelector('[data-collection-list]');
  const buttonWrapper = trigger.closest('.pagination-button');
  if (!sectionId || !listEl) return;

  url.searchParams.set('section_id', sectionId);

  trigger.setAttribute('aria-busy', 'true');
  if (buttonWrapper) buttonWrapper.classList.add('is-loading');

  fetch(url.toString())
    .then((r) => r.text())
    .then((html) => {
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      const nextSection = doc.querySelector(`[data-collection-section][data-section-id="${sectionId}"]`);
      if (!nextSection) return;
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
      } else {
        if (buttonWrapper) buttonWrapper.remove();
      }
    })
    .catch(() => {
      trigger.removeAttribute('aria-busy');
      if (buttonWrapper) buttonWrapper.classList.remove('is-loading');
    });
});
