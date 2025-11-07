if (!customElements.get('product-form')) {
  customElements.define(
    'product-form',
    class ProductForm extends HTMLElement {
      constructor() {
        super();
        this.hideErrors = this.dataset.hideErrors === 'true';
        this._initialized = false;
      }

      get cart() {
        return document.querySelector('cart-notification') || document.querySelector('cart-drawer');
      }

      initialize() {
        // Prevent double initialization
        if (this._initialized) {
          return true;
        }

        // Initialize form elements
        this.form = this.querySelector('form');
        if (!this.form) {
          console.warn('Product form: form element not found, will retry');
          return false;
        }

        // Enable variant input
        if (this.variantIdInput) {
          this.variantIdInput.disabled = false;
        }

        // Check if listener is already attached by checking for a data attribute
        if (!this.form.dataset.submitHandlerAttached) {
          // Add submit handler
          this.form.addEventListener('submit', this.onSubmitHandler.bind(this));
          this.form.dataset.submitHandlerAttached = 'true';
          console.log('Product form: submit handler attached to form');
        }

        // Clear error message when quantity changes
        const quantityInput = this.form.querySelector('input[name="quantity"]');
        if (quantityInput && !quantityInput.dataset.errorHandlerAttached) {
          quantityInput.addEventListener('input', () => {
            // Clear error when user changes quantity
            this.handleErrorMessage();
          });
          quantityInput.addEventListener('change', () => {
            // Clear error when user changes quantity
            this.handleErrorMessage();
          });
          quantityInput.dataset.errorHandlerAttached = 'true';
        }

        // Clear error message when variant changes
        if (this.variantIdInput && !this.variantIdInput.dataset.errorHandlerAttached) {
          this.variantIdInput.addEventListener('change', () => {
            // Clear error when variant changes
            this.handleErrorMessage();
          });
          this.variantIdInput.dataset.errorHandlerAttached = 'true';
        }

        // Get submit button
        this.submitButton = this.querySelector('[type="submit"]');
        if (!this.submitButton) {
          console.warn('Product form: submit button not found, will retry');
          return false;
        }

        this.submitButtonText = this.submitButton.querySelector('span');

        // Set aria attributes
        if (document.querySelector('cart-drawer')) {
          this.submitButton.setAttribute('aria-haspopup', 'dialog');
        }

        // Add direct click handler as backup (in case form submit doesn't fire)
        // This ensures the form submits even if the submit event isn't triggered
        if (!this.submitButton.dataset.clickHandlerAttached) {
          this.submitButton.addEventListener(
            'click',
            (e) => {
              // Don't prevent default - let form submit work normally
              // This is just a backup to ensure submission happens
              console.log('Product form: button clicked', {
                disabled: this.submitButton.disabled,
                variantId: this.variantIdInput?.value,
              });

              // If button is disabled, prevent submission
              if (this.submitButton.disabled || this.submitButton.getAttribute('aria-disabled') === 'true') {
                e.preventDefault();
                e.stopPropagation();
                console.log('Product form: submission prevented - button is disabled');
                return false;
              }

              // If no variant ID, prevent submission
              if (!this.variantIdInput || !this.variantIdInput.value) {
                e.preventDefault();
                e.stopPropagation();
                console.log('Product form: submission prevented - no variant ID');
                return false;
              }
            },
            true
          ); // Use capture phase to catch early
          this.submitButton.dataset.clickHandlerAttached = 'true';
          console.log('Product form: click handler attached to button');
        }

        this._initialized = true;
        console.log('Product form: initialized successfully');
        return true;
      }

      connectedCallback() {
        // Try to initialize immediately
        if (this.initialize()) {
          return;
        }

        // If initialization failed, try again when DOM is ready
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', () => {
            if (!this._initialized) {
              this.initialize();
            }
          });
        } else {
          // DOM is already ready, try again after a short delay
          setTimeout(() => {
            if (!this._initialized) {
              this.initialize();
            }
          }, 0);
        }
      }

      onSubmitHandler(evt) {
        evt.preventDefault();
        console.log('Product form: submit handler called');

        // Safety checks
        if (!this.form) {
          console.error('Product form: form not initialized');
          return;
        }

        if (!this.submitButton) {
          console.error('Product form: submit button not found');
          return;
        }

        // Check if button is disabled (both attribute and property)
        if (this.submitButton.getAttribute('aria-disabled') === 'true' || this.submitButton.disabled) {
          console.log('Product form: button is disabled', {
            ariaDisabled: this.submitButton.getAttribute('aria-disabled'),
            disabled: this.submitButton.disabled,
          });
          return;
        }

        // Re-get variant input to ensure we have the latest value
        const variantInput = this.variantIdInput;
        if (!variantInput) {
          console.error('Product form: variant input not found');
          return;
        }

        console.log('Product form: variant input state', {
          value: variantInput.value,
          disabled: variantInput.disabled,
          hasValue: !!variantInput.value,
        });

        if (variantInput.disabled) {
          console.error('Product form: variant input is disabled');
          return;
        }

        // Check for required utilities
        if (typeof fetchConfig !== 'function') {
          console.error('Product form: fetchConfig is not defined');
          return;
        }

        if (typeof routes === 'undefined' || !routes.cart_add_url) {
          console.error('Product form: routes.cart_add_url is not defined');
          return;
        }

        console.log('Product form: proceeding with cart add');
        this.handleErrorMessage();

        // Set loading state
        this.submitButton.setAttribute('aria-disabled', true);
        this.submitButton.classList.add('loading');
        const loadingSpinner =
          this.submitButton.querySelector('.loading__spinner') || this.querySelector('.loading__spinner');
        if (loadingSpinner) {
          loadingSpinner.classList.remove('hidden');
        }

        const config = fetchConfig('javascript');
        if (!config) {
          console.error('Product form: fetchConfig returned null/undefined');
          // Reset button state
          this.submitButton.classList.remove('loading');
          this.submitButton.removeAttribute('aria-disabled');
          if (loadingSpinner) {
            loadingSpinner.classList.add('hidden');
          }
          return;
        }

        config.headers['X-Requested-With'] = 'XMLHttpRequest';
        delete config.headers['Content-Type'];

        // Get variant ID directly from input (more reliable than FormData)
        const variantId = this.variantIdInput.value;
        console.log('Product form: variant ID from input:', variantId);

        if (!variantId || variantId === '') {
          console.error('Product form: variant ID is missing or empty');
          console.error('Variant input:', this.variantIdInput);
          this.handleErrorMessage('Please select a product option');
          // Reset button state
          this.submitButton.classList.remove('loading');
          this.submitButton.removeAttribute('aria-disabled');
          const loadingSpinner =
            this.submitButton.querySelector('.loading__spinner') || this.querySelector('.loading__spinner');
          if (loadingSpinner) {
            loadingSpinner.classList.add('hidden');
          }
          return;
        }

        // Check quantity before proceeding
        const quantityInput = this.form.querySelector('input[name="quantity"]');
        if (quantityInput) {
          const requestedQuantity = parseInt(quantityInput.value) || 1;
          const maxQuantity = quantityInput.max ? parseInt(quantityInput.max) : null;

          console.log('Product form: quantity check', {
            requested: requestedQuantity,
            max: maxQuantity,
            maxAttribute: quantityInput.max,
          });

          // Check if quantity exceeds max (inventory limit)
          if (maxQuantity !== null && requestedQuantity > maxQuantity) {
            const errorMessage = `Only ${maxQuantity} ${
              maxQuantity === 1 ? 'item is' : 'items are'
            } available in stock. Please select a quantity of ${maxQuantity} or less.`;
            this.handleErrorMessage(errorMessage);
            // Reset button state
            this.submitButton.classList.remove('loading');
            this.submitButton.removeAttribute('aria-disabled');
            if (loadingSpinner) {
              loadingSpinner.classList.add('hidden');
            }
            // Clear any previous error after a short delay to allow user to see it
            setTimeout(() => {
              // Error will be cleared when user changes quantity or variant
            }, 5000);
            return;
          }

          // Also check HTML5 validation in case max was set but bypassed
          if (!quantityInput.checkValidity()) {
            const validationMessage = quantityInput.validationMessage;
            if (validationMessage && validationMessage.includes('range')) {
              this.handleErrorMessage(
                validationMessage || 'Please select a valid quantity within the available stock.'
              );
              // Reset button state
              this.submitButton.classList.remove('loading');
              this.submitButton.removeAttribute('aria-disabled');
              if (loadingSpinner) {
                loadingSpinner.classList.add('hidden');
              }
              return;
            }
          }
        }

        const formData = new FormData(this.form);

        // Ensure variant ID is in form data
        if (!formData.get('id') || formData.get('id') !== variantId) {
          formData.set('id', variantId);
          console.log('Product form: set variant ID in formData:', variantId);
        }

        if (this.cart && typeof this.cart.getSectionsToRender === 'function') {
          const sections = this.cart.getSectionsToRender();
          if (sections && sections.length > 0) {
            formData.append(
              'sections',
              sections.map((section) => section.id).join(',')
            );
            formData.append('sections_url', window.location.pathname);
          }
          if (typeof this.cart.setActiveElement === 'function') {
            this.cart.setActiveElement(document.activeElement);
          }
        }

        // Universal path: use CartDrawerAPI if present
        if (window.CartDrawerAPI && typeof window.CartDrawerAPI.addToCart === 'function') {
          console.log('Product form: using CartDrawerAPI');
          window.CartDrawerAPI
            .addToCart(formData, this.submitButton)
            .then(() => {
              this.error = false;
              this.submitButton.classList.remove('loading');
              this.submitButton.removeAttribute('aria-disabled');
              const loadingSpinner = this.submitButton.querySelector('.loading__spinner') || this.querySelector('.loading__spinner');
              if (loadingSpinner) loadingSpinner.classList.add('hidden');
            })
            .catch((err) => {
              console.error('CartDrawerAPI error:', err);
              this.handleErrorMessage(err?.message || 'Unable to add item to cart. Please try again.');
              this.error = true;
              this.submitButton.classList.remove('loading');
              this.submitButton.removeAttribute('aria-disabled');
              const loadingSpinner = this.submitButton.querySelector('.loading__spinner') || this.querySelector('.loading__spinner');
              if (loadingSpinner) loadingSpinner.classList.add('hidden');
            });
          return;
        }

        config.body = formData;

        console.log('Product form: sending request to:', routes.cart_add_url);
        fetch(`${routes.cart_add_url}`, config)
          .then(async (response) => {
            // For 422 errors, try to parse the error response
            if (!response.ok) {
              let errorData = null;
              try {
                errorData = await response.json();
                console.log('Product form: error response data:', errorData);
              } catch (e) {
                console.error('Product form: failed to parse error response:', e);
              }

              // If we have error data, return it so we can handle it below
              if (errorData) {
                return { status: 'error', httpStatus: response.status, ...errorData };
              }

              throw new Error(`HTTP error! status: ${response.status}`);
            }
            return response.json();
          })
          .then((response) => {
            // Handle both error responses (422 with status: 'error') and normal error responses
            if (response.status === 'error' || response.status) {
              publish(PUB_SUB_EVENTS.cartError, {
                source: 'product-form',
                productVariantId: formData.get('id'),
                errors: response.errors || response.description,
                message: response.message,
              });

              // Check for inventory/quantity errors
              let errorMessage = response.description || response.message;

              // Shopify 422 errors often have errors in different formats
              if (response.errors) {
                // Shopify returns errors in different formats
                if (typeof response.errors === 'string') {
                  errorMessage = response.errors;
                } else if (Array.isArray(response.errors)) {
                  errorMessage = response.errors.join(', ');
                } else if (response.errors.quantity) {
                  // Handle quantity-specific errors
                  errorMessage = response.errors.quantity;
                } else if (response.errors.message) {
                  errorMessage = response.errors.message;
                } else if (typeof response.errors === 'object') {
                  // Try to extract first error value
                  const errorKeys = Object.keys(response.errors);
                  if (errorKeys.length > 0) {
                    const firstError = response.errors[errorKeys[0]];
                    if (Array.isArray(firstError)) {
                      errorMessage = firstError.join(', ');
                    } else if (typeof firstError === 'string') {
                      errorMessage = firstError;
                    }
                  }
                }
              }

              // If we still don't have a message, try to create one from the HTTP status
              if (!errorMessage || errorMessage === '') {
                if (response.httpStatus === 422) {
                  errorMessage = 'Unable to add this quantity to cart. Please check the available stock and try again.';
                } else {
                  errorMessage = 'Unable to add item to cart. Please check your selection and try again.';
                }
              }

              console.log('Product form: displaying error message:', errorMessage);
              this.handleErrorMessage(errorMessage);

              // Reset button state
              this.submitButton.classList.remove('loading');
              this.submitButton.removeAttribute('aria-disabled');
              const loadingSpinner =
                this.submitButton.querySelector('.loading__spinner') || this.querySelector('.loading__spinner');
              if (loadingSpinner) {
                loadingSpinner.classList.add('hidden');
              }

              const soldOutMessage = this.submitButton.querySelector('.sold-out-message');
              if (soldOutMessage) {
                this.submitButton.setAttribute('aria-disabled', true);
                if (this.submitButtonText) {
                  this.submitButtonText.classList.add('hidden');
                }
                soldOutMessage.classList.remove('hidden');
              }
              this.error = true;
              return;
            } else if (!this.cart) {
              window.location = window.routes.cart_url;
              return;
            }

            // Ensure cart drawer is found
            if (!this.cart) {
              console.error('Cart drawer not found');
              return;
            }

            if (!this.error) {
              // Log response for debugging
              console.log('Cart add response:', response);

              // Shopify cart add API doesn't return item_count in the response
              // We need to fetch the current cart state to get the accurate count
              fetch(`${routes.cart_url}.js`)
                .then((res) => res.json())
                .then((cart) => {
                  console.log('Cart state fetched after add:', cart);
                  console.log('Cart item_count:', cart.item_count);

                  // Publish cart update with accurate cart data
                  publish(PUB_SUB_EVENTS.cartUpdate, {
                    source: 'product-form',
                    productVariantId: formData.get('id'),
                    cartData: {
                      item_count: cart.item_count,
                      items: cart.items,
                      total_quantity: cart.total_quantity,
                    },
                  });
                })
                .catch((e) => {
                  console.error('Error fetching cart state:', e);
                  // Fallback: try to estimate from response
                  const estimatedCount = response.item ? 1 : 0;
                  publish(PUB_SUB_EVENTS.cartUpdate, {
                    source: 'product-form',
                    productVariantId: formData.get('id'),
                    cartData: {
                      item_count: estimatedCount,
                      items: response.item ? [response.item] : [],
                    },
                  });
                });
            }
            this.error = false;
            const quickAddModal = this.closest('quick-add-modal');
            if (quickAddModal) {
              document.body.addEventListener(
                'modalClosed',
                () => {
                  setTimeout(() => {
                    if (this.cart && typeof this.cart.renderContents === 'function') {
                      this.cart.renderContents(response);
                    }
                  });
                },
                { once: true }
              );
              quickAddModal.hide(true);
            } else {
              if (this.cart && typeof this.cart.renderContents === 'function') {
                this.cart.renderContents(response);
              } else {
                console.error('Cart renderContents method not available');
              }
            }
          })
          .catch((error) => {
            console.error('Product form: fetch error:', error);
            // Handle network errors or other fetch failures (like 422 that we didn't catch)
            let errorMessage = 'Unable to add item to cart. Please check your connection and try again.';

            // If it's a known error, try to extract message
            if (error.message && error.message.includes('HTTP error')) {
              errorMessage = 'Unable to add this quantity to cart. Please check the available stock and try again.';
            }

            this.handleErrorMessage(errorMessage);

            // Reset button state
            this.submitButton.classList.remove('loading');
            this.submitButton.removeAttribute('aria-disabled');
            const loadingSpinner =
              this.submitButton.querySelector('.loading__spinner') || this.querySelector('.loading__spinner');
            if (loadingSpinner) {
              loadingSpinner.classList.add('hidden');
            }

            this.error = true;
          })
          .finally(() => {
            // Only reset loading state if we haven't already handled an error
            if (!this.error) {
              this.submitButton.classList.remove('loading');
              if (this.cart && this.cart.classList.contains('is-empty')) this.cart.classList.remove('is-empty');
              this.submitButton.removeAttribute('aria-disabled');
            }
            const loadingSpinner =
              this.submitButton.querySelector('.loading__spinner') || this.querySelector('.loading__spinner');
            if (loadingSpinner) {
              loadingSpinner.classList.add('hidden');
            }
          });
      }

      handleErrorMessage(errorMessage = false) {
        if (this.hideErrors) {
          console.log('Product form: error messages are hidden');
          return;
        }

        // Try to find error wrapper in this element first, then in parent elements
        this.errorMessageWrapper =
          this.errorMessageWrapper ||
          this.querySelector('.product-form__error-message-wrapper') ||
          this.closest('.product-form')?.parentElement?.querySelector('.product-form__error-message-wrapper') ||
          this.closest('.product-form__bottom')?.parentElement?.querySelector('.product-form__error-message-wrapper') ||
          document.querySelector(`.product-form__error-message-wrapper`);
        if (!this.errorMessageWrapper) {
          console.warn('Product form: error message wrapper not found');
          return;
        }
        this.errorMessage = this.errorMessage || this.errorMessageWrapper.querySelector('.product-form__error-message');

        if (!this.errorMessage) {
          console.warn('Product form: error message element not found');
          return;
        }

        console.log('Product form: handleErrorMessage called', {
          errorMessage: errorMessage,
          wrapperExists: !!this.errorMessageWrapper,
          messageElementExists: !!this.errorMessage,
          currentlyHidden: this.errorMessageWrapper.hasAttribute('hidden'),
        });

        // Remove hidden attribute to show, add it to hide
        if (errorMessage) {
          this.errorMessageWrapper.removeAttribute('hidden');
          this.errorMessage.textContent = errorMessage;
          // Also set display style to ensure visibility
          this.errorMessageWrapper.style.display = '';
          console.log('Product form: error message displayed:', errorMessage);
        } else {
          this.errorMessageWrapper.setAttribute('hidden', '');
          this.errorMessage.textContent = '';
        }
      }

      toggleSubmitButton(disable = true, text) {
        if (disable) {
          this.submitButton.setAttribute('disabled', 'disabled');
          if (text) this.submitButtonText.textContent = text;
        } else {
          this.submitButton.removeAttribute('disabled');
          this.submitButtonText.textContent = window.variantStrings.addToCart;
        }
      }

      get variantIdInput() {
        return this.form.querySelector('[name=id]');
      }
    }
  );
}

// Initialize any existing product-form elements that might be in the DOM
// This handles the case where the script loads after the element is already in the DOM
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('product-form').forEach((form) => {
      if (form._initialized !== true) {
        form.initialize();
      }
    });
  });
} else {
  // DOM is already ready
  setTimeout(() => {
    document.querySelectorAll('product-form').forEach((form) => {
      if (form._initialized !== true) {
        form.initialize();
      }
    });
  }, 0);
}
