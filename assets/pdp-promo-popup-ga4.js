(() => {
  const EVENT_SOURCE = 'pdp_promo_popup';

  const STORAGE_KEYS = {
    subscriptionConfirmed: 'rcPdpPromoEmailSubmitted',
    impressions: 'rcPdpPromoImpressions',
    sessionShown: 'rcPdpPromoShown',
    sessionDismissed: 'rcPdpPromoDismissed',
    sessionCopied: 'rcPdpPromoCopied',
  };

  const DAY = 24 * 60 * 60 * 1000;
  const WEEK = 7 * DAY;
  const MIN_SENDING_DURATION = 700;

  const readStorage = (storage, key) => {
    try {
      return storage.getItem(key);
    } catch {
      return null;
    }
  };

  const writeStorage = (storage, key, value) => {
    try {
      storage.setItem(key, value);
    } catch {
      // Storage may be unavailable in privacy mode; the popup should still work.
    }
  };

  const runWhenIdle = (callback) => {
    if ('requestIdleCallback' in window) {
      window.requestIdleCallback(callback, { timeout: 2000 });
      return;
    }

    window.setTimeout(callback, 200);
  };

  const removeBlankParams = (params) =>
    Object.fromEntries(
      Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== '')
    );

  const buildEventParams = (popup, code) =>
    removeBlankParams({
      product_id: popup.dataset.productId,
      product_handle: popup.dataset.productHandle,
      promo_code: popup.dataset.promoCode || code,
      source: EVENT_SOURCE,
    });

  const trackEvent = (eventName, params) => {
    const payload = removeBlankParams({
      event: eventName,
      ...params,
    });

    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push(payload);
    window.dispatchEvent(new CustomEvent('pdpPromoPopup:analytics', { detail: payload }));
  };

  const getRecentImpressions = () => {
    const stored = readStorage(window.localStorage, STORAGE_KEYS.impressions);
    if (!stored) return [];

    try {
      return JSON.parse(stored).filter(
        (timestamp) => Number.isFinite(timestamp) && Date.now() - timestamp < WEEK
      );
    } catch {
      return [];
    }
  };

  const isFrequencyCapped = () => {
    const impressions = getRecentImpressions();
    writeStorage(window.localStorage, STORAGE_KEYS.impressions, JSON.stringify(impressions));

    const lastImpression = impressions[impressions.length - 1];
    return Boolean(lastImpression && Date.now() - lastImpression < DAY) || impressions.length >= 2;
  };

  const recordImpression = () => {
    const impressions = [...getRecentImpressions(), Date.now()];
    writeStorage(window.localStorage, STORAGE_KEYS.impressions, JSON.stringify(impressions));
    writeStorage(window.sessionStorage, STORAGE_KEYS.sessionShown, 'true');
  };

  const copyText = async (text) => {
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch {
        // Fall through for browsers that expose Clipboard API but deny access.
      }
    }

    const input = document.createElement('textarea');
    input.value = text;
    input.setAttribute('readonly', '');
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.appendChild(input);
    input.select();
    document.execCommand('copy');
    input.remove();
  };

  const initializePopup = (popup) => {
    if (popup.dataset.initialized === 'true') return;
    popup.dataset.initialized = 'true';

    const isDesignMode = popup.dataset.designMode === 'true' || window.Shopify?.designMode;
    const hasSuccess = popup.dataset.formSuccess === 'true';
    const hasError = popup.dataset.formError === 'true';
    const isPreviewForced = new URLSearchParams(window.location.search).get('welcome_popup_preview') === '1';
    const delay = Math.max(0, Number(popup.dataset.triggerDelay) || 10) * 1000;
    const overlay = popup.closest('[data-pdp-promo-overlay]');
    const dialogComponent = popup.closest('[data-pdp-promo-dialog-component]');
    const closeButton = popup.querySelector('[data-pdp-promo-close]');
    const copyButton = popup.querySelector('[data-pdp-promo-copy]');
    const popupImage = popup.querySelector('[data-pdp-promo-image]');
    const code = popup.querySelector('[data-pdp-promo-code]')?.textContent.trim() || 'WELCOME10';
    const form = popup.closest('form');
    const reopenButton = form?.querySelector('[data-pdp-promo-reopen]');
    const emailInput = popup.querySelector('input[type="email"]');
    const submitButton = popup.querySelector('[data-pdp-promo-submit]');
    const eventParams = buildEventParams(popup, code);
    let hasTrackedView = false;
    let timer;
    let isSubmitting = false;
    let pendingCloseOptions;
    let previouslyFocusedElement;
    let closeWasHandled = true;
    let openedWithDialogComponent = false;

    const cartDrawerDialog = () => document.querySelector('.cart-drawer__dialog');
    const isCartDrawerOpen = () => Boolean(cartDrawerDialog()?.open);
    const isSubscriptionConfirmed = () =>
      readStorage(window.localStorage, STORAGE_KEYS.subscriptionConfirmed) === 'true';

    const initializeCapsule = () => {
      if (!reopenButton) return;

      const revealCapsule = () => {
        reopenButton.classList.add('is-ready');
        reopenButton.hidden = !isDesignMode && isSubscriptionConfirmed();
      };

      if (isDesignMode || document.readyState === 'complete') {
        if (isDesignMode) {
          revealCapsule();
        } else {
          runWhenIdle(revealCapsule);
        }
        return;
      }

      window.addEventListener('load', () => runWhenIdle(revealCapsule), { once: true });
    };

    const loadPopupImage = () => {
      if (!popupImage || popupImage.dataset.loaded === 'true') return;

      if (popupImage.dataset.srcset) popupImage.srcset = popupImage.dataset.srcset;
      if (popupImage.dataset.src) popupImage.src = popupImage.dataset.src;
      popupImage.dataset.loaded = 'true';
    };

    const applyClosedState = ({ userDismissal = false } = {}) => {
      if (userDismissal) {
        writeStorage(window.sessionStorage, STORAGE_KEYS.sessionDismissed, 'true');
        if (!isDesignMode) trackEvent('pdp_promo_close', eventParams);
      }

      if (previouslyFocusedElement instanceof HTMLElement && previouslyFocusedElement.isConnected) {
        previouslyFocusedElement.focus();
      }
      previouslyFocusedElement = undefined;
    };

    const handleDialogClosed = () => {
      if (closeWasHandled) return;
      closeWasHandled = true;
      const closeOptions = pendingCloseOptions || { userDismissal: true };
      pendingCloseOptions = undefined;
      applyClosedState(closeOptions);
    };

    const show = ({ record = true, trackView = true } = {}) => {
      if (isCartDrawerOpen()) return false;
      window.clearTimeout(timer);
      loadPopupImage();
      if (!overlay?.open) {
        previouslyFocusedElement = document.activeElement;
        closeWasHandled = false;
        openedWithDialogComponent = typeof dialogComponent?.showDialog === 'function';
        if (openedWithDialogComponent) {
          dialogComponent.showDialog();
        } else {
          overlay?.showModal();
        }
      }
      if (trackView && !isDesignMode && !hasTrackedView) {
        trackEvent('pdp_promo_view', eventParams);
        hasTrackedView = true;
      }
      if (record && !isDesignMode) recordImpression();
      return true;
    };

    const hide = ({ userDismissal = false } = {}) => {
      const closeOptions = { userDismissal };
      if (!overlay?.open) {
        applyClosedState(closeOptions);
        return;
      }

      pendingCloseOptions = closeOptions;
      if (typeof dialogComponent?.closeDialog === 'function') {
        dialogComponent.closeDialog();
      } else {
        overlay.close();
        handleDialogClosed();
      }
    };

    const showSubmitError = () => {
      let error = popup.querySelector('[data-pdp-promo-submit-error]');
      if (!error) {
        error = document.createElement('p');
        error.className = 'pdp-promo-popup__error';
        error.dataset.pdpPromoSubmitError = '';
        error.setAttribute('role', 'alert');
        submitButton?.insertAdjacentElement('beforebegin', error);
      }
      error.textContent = popup.dataset.submitError || 'We couldn’t send that right now. Please try again.';
    };

    const showSubmitSuccess = () => {
      const content = popup.querySelector('.pdp-promo-popup__content');
      if (!content) return;

      const success = document.createElement('div');
      success.className = 'pdp-promo-popup__success';
      success.dataset.pdpPromoSuccess = '';
      success.tabIndex = -1;

      const heading = document.createElement('h2');
      heading.className = 'pdp-promo-popup__success-heading';
      heading.textContent = popup.dataset.successHeading || 'Check your inbox';

      const message = document.createElement('p');
      message.className = 'pdp-promo-popup__success-copy';
      message.textContent =
        popup.dataset.successMessage ||
        "You're subscribed. Your welcome email should arrive shortly—please check your spam folder too.";

      success.append(heading, message);
      content.replaceWith(success);
      overlay?.setAttribute('aria-label', heading.textContent);
      if (overlay?.open) success.focus();
    };

    closeButton?.addEventListener('click', () => {
      hide({ userDismissal: true });
    });

    dialogComponent?.addEventListener('dialog:close', handleDialogClosed);
    overlay?.addEventListener('close', handleDialogClosed);
    overlay?.addEventListener('cancel', (event) => {
      if (openedWithDialogComponent) return;
      event.preventDefault();
      hide({ userDismissal: true });
    });
    overlay?.addEventListener('keydown', (event) => {
      if (openedWithDialogComponent || event.key !== 'Escape') return;
      event.preventDefault();
      hide({ userDismissal: true });
    });
    overlay?.addEventListener('click', (event) => {
      if (openedWithDialogComponent || event.target !== overlay) return;
      hide({ userDismissal: true });
    });

    reopenButton?.addEventListener('click', () => {
      show({ record: false });
    });

    copyButton?.addEventListener('click', async () => {
      const copyLabel = copyButton.dataset.copyLabel || 'Copy';
      const copiedLabel = copyButton.dataset.copiedLabel || 'Copied';

      try {
        await copyText(code);
        writeStorage(window.sessionStorage, STORAGE_KEYS.sessionCopied, 'true');
        if (!isDesignMode) trackEvent('pdp_promo_copy', eventParams);
        copyButton.textContent = copiedLabel;
        window.setTimeout(() => {
          copyButton.textContent = copyLabel;
        }, 1800);
      } catch {
        copyButton.textContent = code;
      }
    });

    const submitForm = async (event) => {
      event?.preventDefault();
      if (isDesignMode || isSubmitting) return;
      if (!form?.reportValidity()) return;

      isSubmitting = true;
      const submissionStartedAt = Date.now();
      if (!isDesignMode) trackEvent('pdp_promo_email_submit', eventParams);
      popup.setAttribute('aria-busy', 'true');
      popup.querySelector('[data-pdp-promo-submit-error]')?.remove();
      const submitLabel = submitButton?.textContent;
      if (submitButton) {
        submitButton.disabled = true;
        submitButton.textContent = submitButton.dataset.sendingLabel || 'Sending...';
      }

      const waitForMinimumSendingDuration = async () => {
        const remainingSendingTime = MIN_SENDING_DURATION - (Date.now() - submissionStartedAt);
        if (remainingSendingTime > 0) {
          await new Promise((resolve) => window.setTimeout(resolve, remainingSendingTime));
        }
      };

      try {
        const response = await fetch(form.action, {
          method: form.method || 'post',
          body: new FormData(form),
          credentials: 'same-origin',
          redirect: 'follow',
        });
        const responseHtml = await response.text();
        const responsePopup = new DOMParser()
          .parseFromString(responseHtml, 'text/html')
          .querySelector('[data-pdp-promo-popup]');

        if (!response.ok || responsePopup?.dataset.formSuccess !== 'true') {
          throw new Error('Customer form submission was not confirmed.');
        }

        await waitForMinimumSendingDuration();
        writeStorage(window.localStorage, STORAGE_KEYS.subscriptionConfirmed, 'true');
        if (reopenButton) reopenButton.hidden = true;
        if (!isDesignMode) trackEvent('pdp_promo_email_success', eventParams);
        showSubmitSuccess();
      } catch {
        await waitForMinimumSendingDuration();
        showSubmitError();
        if (submitButton) {
          submitButton.disabled = false;
          submitButton.textContent = submitLabel || 'Unlock my 10% off';
        }
      } finally {
        isSubmitting = false;
        popup.removeAttribute('aria-busy');
      }
    };

    form?.addEventListener('submit', submitForm);
    emailInput?.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.isComposing) return;
      event.preventDefault();
      form?.requestSubmit();
    });
    submitButton?.addEventListener('click', () => form?.requestSubmit());

    initializeCapsule();

    if (hasSuccess) {
      writeStorage(window.localStorage, STORAGE_KEYS.subscriptionConfirmed, 'true');
      if (reopenButton) reopenButton.hidden = true;
      if (!isDesignMode) trackEvent('pdp_promo_email_success', eventParams);
      show({ record: false, trackView: false });
      popup.querySelector('[data-pdp-promo-success]')?.focus();
      return;
    }

    if (hasError || isDesignMode || isPreviewForced) {
      show({ record: false, trackView: false });
      return;
    }

    const permanentlyExcluded = isSubscriptionConfirmed();
    const shownThisSession =
      readStorage(window.sessionStorage, STORAGE_KEYS.sessionShown) === 'true';
    const dismissedThisSession =
      readStorage(window.sessionStorage, STORAGE_KEYS.sessionDismissed) === 'true';

    if (permanentlyExcluded || shownThisSession || dismissedThisSession || isFrequencyCapped()) {
      return;
    }

    timer = window.setTimeout(() => {
      if (show()) return;

      cartDrawerDialog()?.addEventListener(
        'close',
        () => {
          if (!readStorage(window.sessionStorage, STORAGE_KEYS.sessionDismissed)) show();
        },
        { once: true }
      );
    }, delay);

    document.addEventListener('shopify:section:select', (event) => {
      if (event.target.contains(popup)) show({ record: false });
    });

    document.addEventListener('shopify:section:deselect', (event) => {
      if (event.target.contains(popup)) hide();
    });
  };

  const initializeAll = (scope = document) => {
    scope.querySelectorAll('[data-pdp-promo-popup]').forEach(initializePopup);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initializeAll());
  } else {
    initializeAll();
  }

  document.addEventListener('shopify:section:load', (event) => initializeAll(event.target));
})();
