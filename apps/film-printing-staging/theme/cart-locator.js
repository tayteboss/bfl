/* F06C preparation only. Not loaded by the theme or wired to the F05 form.
 * A locator is a sensitive cart capability, NOT an owner or complete cart read.
 * https://shopify.dev/docs/api/storefront-events-and-actions/actions/get-cart
 */
(function (root) {
  const store = 'bellows-film-printing-staging.myshopify.com';
  const unavailable = () => new Error('CART_LOCATOR_UNAVAILABLE');
  async function locate() {
    if (root.location?.hostname !== store || typeof root.Shopify?.actions?.getCart !== 'function') throw unavailable();
    // Omit cartId: Shopify resolves the current browser cart. Never manufacture a
    // GID from /cart.js, cookies, an Ajax key, or a browser-supplied cart object.
    let result;
    try { result = await root.Shopify.actions.getCart(); } catch { throw unavailable(); }
    const id = result?.cart?.id;
    if (typeof id !== 'string' || id.length > 4096 || !id.startsWith('gid://shopify/Cart/') || /\s/.test(id)) throw unavailable();
    let url;
    try { url = new URL(id); } catch { throw unavailable(); }
    // A keyless query can redact buyer data. It cannot prove a guest owner.
    if (url.username || url.password || url.hash || !url.pathname.slice('/Cart/'.length) ||
        url.searchParams.getAll('key').length !== 1 || !url.searchParams.get('key')) throw unavailable();
    // Preserve the exact opaque value. No storage, logging, HTTP request,
    // readiness flag, or trust in the returned price/lines/owner is added here.
    return Object.freeze({ cart_id: id });
  }
  root.BFLPrintCartLocator = Object.freeze({ locate });
})(typeof window === 'undefined' ? globalThis : window);
