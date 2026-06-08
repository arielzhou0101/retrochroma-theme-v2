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
    const delay = Math.max(0, Number(popup.dataset.triggerDelay) || 10) * 1000;
    const closeButton = popup.querySelector('[data-pdp-promo-close]');
    const copyButton = popup.querySelector('[data-pdp-promo-copy]');
    const code = popup.querySelector('[data-pdp-promo-code]')?.textContent.trim() || 'WELCOME10';
    const form = popup.closest('form');
    const submitButton = popup.querySelector('[data-pdp-promo-submit]');
    const eventParams = buildEventParams(popup, code);
    let hasTrackedView = false;
    let timer;

    const show = ({ record = true, trackView = true } = {}) => {
      window.clearTimeout(timer);
      popup.classList.add('is-visible');
      popup.setAttribute('aria-hidden', 'false');
      if (trackView && !isDesignMode && !hasTrackedView) {
        trackEvent('pdp_promo_view', eventParams);
        hasTrackedView = true;
      }
      if (record && !isDesignMode) recordImpression();
    };

    const hide = () => {
      popup.classList.remove('is-visible');
      popup.setAttribute('aria-hidden', 'true');
    };

    closeButton?.addEventListener('click', () => {
      writeStorage(window.sessionStorage, STORAGE_KEYS.sessionDismissed, 'true');
      if (!isDesignMode) trackEvent('pdp_promo_close', eventParams);
      hide();
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

    form?.addEventListener('submit', () => {
      if (!isDesignMode) trackEvent('pdp_promo_email_submit', eventParams);
      if (!submitButton) return;
      submitButton.disabled = true;
      submitButton.textContent = submitButton.dataset.sendingLabel || 'Sending...';
    });

    if (hasSuccess) {
      writeStorage(window.localStorage, STORAGE_KEYS.subscribed, 'true');
      if (!isDesignMode) trackEvent('pdp_promo_email_success', eventParams);
      show({ record: false, trackView: false });
      popup.querySelector('[data-pdp-promo-success]')?.focus();
      window.setTimeout(hide, 2200);
      return;
    }

    if (hasError || isDesignMode) {
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
      return;
    }

    timer = window.setTimeout(show, delay);

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
