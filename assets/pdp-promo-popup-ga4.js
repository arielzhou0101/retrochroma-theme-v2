(() => {
  const EVENT_SOURCE = 'pdp_promo_popup';

  const STORAGE_KEYS = {
    subscribed: 'rcPdpPromoEmailSubmitted',
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
    const closeButton = popup.querySelector('[data-pdp-promo-close]');
    const copyButton = popup.querySelector('[data-pdp-promo-copy]');
    const code = popup.querySelector('[data-pdp-promo-code]')?.textContent.trim() || 'WELCOME10';
    const form = popup.closest('form');
    const reopenButton = form?.querySelector('[data-pdp-promo-reopen]');
    const submitButton = popup.querySelector('[data-pdp-promo-submit]');
    const eventParams = buildEventParams(popup, code);
    let hasTrackedView = false;
    let timer;
    let isSubmitting = false;
    let submissionAbortController;
    let submissionCancelled = false;

    const cartDrawerDialog = () => document.querySelector('.cart-drawer__dialog');
    const isCartDrawerOpen = () => Boolean(cartDrawerDialog()?.open);

    const show = ({ record = true, trackView = true } = {}) => {
      if (isCartDrawerOpen()) return false;
      window.clearTimeout(timer);
      if (reopenButton) reopenButton.hidden = true;
      overlay?.classList.add('is-visible');
      overlay?.setAttribute('aria-hidden', 'false');
      popup.setAttribute('aria-hidden', 'false');
      if (trackView && !isDesignMode && !hasTrackedView) {
        trackEvent('pdp_promo_view', eventParams);
        hasTrackedView = true;
      }
      if (record && !isDesignMode) recordImpression();
      return true;
    };

    const hide = ({ showReopenTab = false } = {}) => {
      overlay?.classList.remove('is-visible');
      overlay?.setAttribute('aria-hidden', 'true');
      popup.setAttribute('aria-hidden', 'true');
      if (reopenButton) reopenButton.hidden = !showReopenTab;
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
      message.textContent = popup.dataset.successMessage || 'Your welcome code is on its way.';

      success.append(heading, message);
      content.replaceWith(success);
      success.focus();
    };

    closeButton?.addEventListener('click', () => {
      if (isSubmitting) {
        submissionCancelled = true;
        submissionAbortController?.abort();
      }
      writeStorage(window.sessionStorage, STORAGE_KEYS.sessionDismissed, 'true');
      if (!isDesignMode) trackEvent('pdp_promo_close', eventParams);
      hide({ showReopenTab: true });
    });

    overlay?.addEventListener('click', (event) => {
      if (event.target !== overlay) return;
      if (isSubmitting) return;
      writeStorage(window.sessionStorage, STORAGE_KEYS.sessionDismissed, 'true');
      if (!isDesignMode) trackEvent('pdp_promo_close', eventParams);
      hide({ showReopenTab: true });
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

      isSubmitting = true;
      submissionCancelled = false;
      const submissionStartedAt = Date.now();
      if (!isDesignMode) trackEvent('pdp_promo_email_submit', eventParams);
      popup.setAttribute('aria-busy', 'true');
      const submitLabel = submitButton?.textContent;
      if (submitButton) {
        submitButton.disabled = true;
        submitButton.textContent = submitButton.dataset.sendingLabel || 'Sending...';
      }

      submissionAbortController = new AbortController();
      const requestTimeout = window.setTimeout(() => submissionAbortController?.abort(), 15000);

      try {
        const response = await fetch(form.action, {
          method: form.method || 'post',
          body: new FormData(form),
          credentials: 'same-origin',
          redirect: 'follow',
          signal: submissionAbortController.signal,
        });
        const responseHtml = await response.text();
        const responsePopup = new DOMParser()
          .parseFromString(responseHtml, 'text/html')
          .querySelector('[data-pdp-promo-popup]');

        if (!response.ok || responsePopup?.dataset.formSuccess !== 'true') {
          throw new Error('Customer form submission was not confirmed.');
        }

        writeStorage(window.localStorage, STORAGE_KEYS.subscribed, 'true');
        if (!isDesignMode) trackEvent('pdp_promo_email_success', eventParams);
        showSubmitSuccess();
        window.setTimeout(hide, 2200);
      } catch {
        const remainingSendingTime = MIN_SENDING_DURATION - (Date.now() - submissionStartedAt);
        if (remainingSendingTime > 0) {
          await new Promise((resolve) => window.setTimeout(resolve, remainingSendingTime));
        }
        if (!submissionCancelled) {
          showSubmitError();
          if (submitButton) {
            submitButton.disabled = false;
            submitButton.textContent = submitLabel || 'Unlock my 10% off';
          }
        }
      } finally {
        window.clearTimeout(requestTimeout);
        submissionAbortController = undefined;
        isSubmitting = false;
        popup.removeAttribute('aria-busy');
      }
    };

    form?.addEventListener('submit', submitForm);
    submitButton?.addEventListener('click', submitForm);

    if (hasSuccess) {
      writeStorage(window.localStorage, STORAGE_KEYS.subscribed, 'true');
      if (!isDesignMode) trackEvent('pdp_promo_email_success', eventParams);
      show({ record: false, trackView: false });
      popup.querySelector('[data-pdp-promo-success]')?.focus();
      window.setTimeout(hide, 2200);
      return;
    }

    if (hasError || isDesignMode || isPreviewForced) {
      show({ record: false, trackView: false });
      return;
    }

    const permanentlyExcluded =
      readStorage(window.localStorage, STORAGE_KEYS.subscribed) === 'true';
    const shownThisSession =
      readStorage(window.sessionStorage, STORAGE_KEYS.sessionShown) === 'true';
    const dismissedThisSession =
      readStorage(window.sessionStorage, STORAGE_KEYS.sessionDismissed) === 'true';

    if (permanentlyExcluded || shownThisSession || dismissedThisSession || isFrequencyCapped()) {
      if (dismissedThisSession && !permanentlyExcluded) {
        hide({ showReopenTab: true });
      }
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
