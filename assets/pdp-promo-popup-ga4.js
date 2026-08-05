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
    const urlParams = new URLSearchParams(window.location.search);
    const isPreviewForced = urlParams.get('welcome_popup_preview') === '1';
    const isTimingDebug = urlParams.get('popup_timing_debug') === '1';
    const delay = Math.max(0, Number(popup.dataset.triggerDelay) || 10) * 1000;
    const overlay = popup.closest('[data-pdp-promo-overlay]');
    const closeButton = popup.querySelector('[data-pdp-promo-close]');
    const copyButton = popup.querySelector('[data-pdp-promo-copy]');
    const popupImage = popup.querySelector('[data-pdp-promo-image]');
    const code = popup.querySelector('[data-pdp-promo-code]')?.textContent.trim() || 'WELCOME10';
    const form = popup.closest('form');
    const reopenButton = form?.querySelector('[data-pdp-promo-reopen]');
    const originalContent = popup.querySelector('.pdp-promo-popup__content');
    const emailInput = popup.querySelector('input[type="email"]');
    const submitButton = popup.querySelector('[data-pdp-promo-submit]');
    const eventParams = buildEventParams(popup, code);
    let hasTrackedView = false;
    let timer;
    let isSubmitting = false;
    let isAwaitingCaptcha = false;
    let captchaBindingPoll;
    let captchaTokenPoll;
    let submissionStartedAt = 0;
    let submitLabel;
    let previouslyFocusedElement;
    const timingMarks = {};
    let timingDebugPanel;
    let responseDiagnostics = [];

    const formatDuration = (start, end) =>
      start === undefined || end === undefined ? '—' : `${((end - start) / 1000).toFixed(2)}s`;

    const renderTimingDebug = (status) => {
      if (!isTimingDebug) return;
      if (!timingDebugPanel) {
        timingDebugPanel = document.createElement('pre');
        timingDebugPanel.className = 'pdp-promo-popup__timing-debug';
        timingDebugPanel.setAttribute('aria-live', 'polite');
        overlay?.append(timingDebugPanel);
      }

      timingDebugPanel.textContent = [
        `Status: ${status}`,
        `Click → captcha invoked: ${formatDuration(timingMarks.started, timingMarks.captchaInvoked)}`,
        `Captcha invoked → token: ${formatDuration(timingMarks.captchaInvoked, timingMarks.captchaReady)}`,
        `Shopify request: ${formatDuration(timingMarks.fetchStarted, timingMarks.responseReceived)}`,
        `Response processing: ${formatDuration(timingMarks.responseReceived, timingMarks.responseParsed)}`,
        `Total to UI result: ${formatDuration(timingMarks.started, timingMarks.completed)}`,
        ...responseDiagnostics,
      ].join('\n');
    };

    const markTiming = (name, status) => {
      if (!isTimingDebug) return;
      timingMarks[name] = performance.now();
      renderTimingDebug(status);
    };

    const cartDrawerDialog = () => document.querySelector('.cart-drawer__dialog');
    const isCartDrawerOpen = () => Boolean(cartDrawerDialog()?.open);
    const isSubscriptionConfirmed = () =>
      readStorage(window.localStorage, STORAGE_KEYS.subscriptionConfirmed) === 'true';
    const isCaptchaProtected = () => form?.dataset.pdpPromoCaptchaGuard === 'true';
    const hasCaptchaToken = () =>
      Boolean(
        form?.querySelector('[name="h-captcha-response"]')?.value?.trim() ||
          form?.querySelector('[name="g-recaptcha-response"]')?.value?.trim()
      );
    const stopCaptchaTokenPoll = () => {
      window.clearInterval(captchaTokenPoll);
      captchaTokenPoll = undefined;
    };
    const stopCaptchaBindingPoll = () => {
      window.clearInterval(captchaBindingPoll);
      captchaBindingPoll = undefined;
    };

    const initializeCapsule = () => {
      if (!reopenButton) return;

      const revealCapsule = () => {
        reopenButton.classList.add('is-ready');
        reopenButton.hidden = false;
      };

      if (isDesignMode) {
        revealCapsule();
        return;
      }

      runWhenIdle(revealCapsule);
    };

    const loadPopupImage = () => {
      if (!popupImage || popupImage.dataset.loaded === 'true') return;

      if (popupImage.dataset.srcset) popupImage.srcset = popupImage.dataset.srcset;
      if (popupImage.dataset.src) popupImage.src = popupImage.dataset.src;
      popupImage.dataset.loaded = 'true';
    };

    const getFocusableElements = () =>
      [...(overlay?.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      ) || [])].filter((element) => element instanceof HTMLElement && element.offsetParent !== null);

    const show = ({ record = true, trackView = true } = {}) => {
      if (isCartDrawerOpen()) return false;
      window.clearTimeout(timer);
      loadPopupImage();
      if (overlay && !overlay.classList.contains('is-visible')) {
        previouslyFocusedElement = document.activeElement;
        overlay.classList.add('is-visible');
        overlay.setAttribute('aria-hidden', 'false');
        popup.setAttribute('aria-hidden', 'false');
        document.documentElement.setAttribute('data-pdp-promo-popup-open', '');
        window.requestAnimationFrame(() => {
          const success = popup.querySelector('[data-pdp-promo-success]');
          const focusTarget =
            popup.querySelector('[autofocus]') || success ||
            (emailInput?.isConnected ? emailInput : closeButton);
          focusTarget?.focus();
        });
      }
      if (trackView && !isDesignMode && !hasTrackedView) {
        trackEvent('pdp_promo_view', eventParams);
        hasTrackedView = true;
      }
      if (record && !isDesignMode) recordImpression();
      return true;
    };

    const hide = ({ userDismissal = false, restoreFocus = true } = {}) => {
      if (userDismissal) {
        writeStorage(window.sessionStorage, STORAGE_KEYS.sessionDismissed, 'true');
        if (!isDesignMode) trackEvent('pdp_promo_close', eventParams);
      }

      overlay?.classList.remove('is-visible');
      overlay?.setAttribute('aria-hidden', 'true');
      popup.setAttribute('aria-hidden', 'true');
      document.documentElement.removeAttribute('data-pdp-promo-popup-open');

      if (
        restoreFocus &&
        previouslyFocusedElement instanceof HTMLElement &&
        previouslyFocusedElement.isConnected
      ) {
        previouslyFocusedElement.focus();
      }
      previouslyFocusedElement = undefined;
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
      error.textContent =
        popup.dataset.submitError ||
        'Something went wrong. Please try again.';
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
        'Thanks! Please check your inbox. Your welcome email should arrive shortly—please check your spam folder too.';

      success.append(heading, message);
      if (popup.dataset.successNote) {
        const note = document.createElement('p');
        note.className = 'pdp-promo-popup__success-copy pdp-promo-popup__success-note';
        note.textContent = popup.dataset.successNote;
        success.append(note);
      }
      if (originalContent && popup.dataset.successRetry) {
        const retry = document.createElement('button');
        retry.className = 'pdp-promo-popup__success-retry';
        retry.type = 'button';
        retry.textContent = popup.dataset.successRetry;
        retry.addEventListener('click', () => {
          success.replaceWith(originalContent);
          overlay?.setAttribute(
            'aria-label',
            popup.dataset.signupHeading || 'Special offer'
          );
          if (overlay?.classList.contains('is-visible')) emailInput?.focus();
        });
        success.append(retry);
      }
      content.replaceWith(success);
      overlay?.setAttribute('aria-label', heading.textContent);
      if (overlay?.classList.contains('is-visible')) success.focus();
    };

    closeButton?.addEventListener('click', () => {
      hide({ userDismissal: true });
    });

    overlay?.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        hide({ userDismissal: true });
        return;
      }

      if (event.key !== 'Tab') return;
      const focusableElements = getFocusableElements();
      if (!focusableElements.length) {
        event.preventDefault();
        return;
      }

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];
      if (event.shiftKey && document.activeElement === firstElement) {
        event.preventDefault();
        lastElement.focus();
      } else if (!event.shiftKey && document.activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    });
    overlay?.addEventListener('click', (event) => {
      if (event.target !== overlay) return;
      hide({ userDismissal: true });
    });

    reopenButton?.addEventListener('click', () => show({ record: false }));

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

    const startSubmissionState = () => {
      submissionStartedAt = Date.now();
      Object.keys(timingMarks).forEach((key) => delete timingMarks[key]);
      responseDiagnostics = [];
      markTiming('started', 'Waiting for captcha');
      if (!isDesignMode) trackEvent('pdp_promo_email_submit', eventParams);
      popup.setAttribute('aria-busy', 'true');
      popup.querySelector('[data-pdp-promo-submit-error]')?.remove();
      submitLabel = submitButton?.textContent;
      if (submitButton) {
        submitButton.disabled = true;
        submitButton.textContent = submitButton.dataset.sendingLabel || 'Sending...';
      }
    };

    const performSubmission = async () => {
      if (isSubmitting) return;
      isSubmitting = true;
      markTiming('fetchStarted', 'Waiting for Shopify');

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
        markTiming('responseReceived', 'Reading Shopify response');
        const responseHtml = await response.text();
        const responseDocument = new DOMParser().parseFromString(responseHtml, 'text/html');
        const responsePopup = responseDocument.querySelector('[data-pdp-promo-popup]');
        const responseError =
          responseDocument.querySelector('[data-pdp-promo-submit-error], .pdp-promo-popup__error')
            ?.textContent?.trim() ||
          responseDocument.querySelector('.errors, [class*="captcha"] [class*="error"]')
            ?.textContent?.trim();
        responseDiagnostics = [
          `HTTP: ${response.status} ${response.statusText || ''}`.trim(),
          `Final URL: ${new URL(response.url).pathname}${new URL(response.url).search}`,
          `Redirected: ${response.redirected}`,
          `Content-Type: ${response.headers.get('content-type') || 'unknown'}`,
          `Response title: ${responseDocument.title || '(none)'}`,
          `Popup result: success=${responsePopup?.dataset.formSuccess || 'missing'}, error=${responsePopup?.dataset.formError || 'missing'}`,
          `Form error: ${responseError || '(none)'}`,
        ];
        markTiming('responseParsed', 'Processing result');

        if (!response.ok || responsePopup?.dataset.formSuccess !== 'true') {
          throw new Error('Customer form submission was not confirmed.');
        }

        await waitForMinimumSendingDuration();
        writeStorage(window.localStorage, STORAGE_KEYS.subscriptionConfirmed, 'true');
        if (!isDesignMode) trackEvent('pdp_promo_email_success', eventParams);
        showSubmitSuccess();
        markTiming('completed', 'Success');
      } catch (error) {
        if (!responseDiagnostics.length) {
          responseDiagnostics = [`Request error: ${error?.message || 'Unknown error'}`];
        }
        await waitForMinimumSendingDuration();
        showSubmitError();
        if (submitButton) {
          submitButton.disabled = false;
          submitButton.textContent = submitLabel || 'Unlock my 10% off';
        }
        markTiming('completed', 'Error');
      } finally {
        isSubmitting = false;
        popup.removeAttribute('aria-busy');
      }
    };

    const completeCaptchaSubmission = () => {
      if (!isAwaitingCaptcha || isSubmitting || !hasCaptchaToken()) return;

      markTiming('captchaReady', 'Captcha ready');
      stopCaptchaBindingPoll();
      stopCaptchaTokenPoll();
      isAwaitingCaptcha = false;
      performSubmission();
    };

    const executeCaptchaWhenReady = () => {
      if (!isAwaitingCaptcha || form?.dataset.hcaptchaBound !== 'true') return false;

      stopCaptchaBindingPoll();
      markTiming('captchaInvoked', 'Waiting for captcha token');
      form.submit();
      return true;
    };

    const requestSubmission = () => {
      if (isDesignMode || isSubmitting || isAwaitingCaptcha) return;
      if (!form?.reportValidity()) return;

      startSubmissionState();
      if (!isCaptchaProtected()) {
        markTiming('captchaInvoked', 'Captcha not required');
        markTiming('captchaReady', 'Captcha not required');
        performSubmission();
        return;
      }

      isAwaitingCaptcha = true;
      form
        ?.querySelectorAll('[name="h-captcha-response"], [name="g-recaptcha-response"]')
        .forEach((input) => {
          input.value = '';
        });
      stopCaptchaBindingPoll();
      stopCaptchaTokenPoll();
      captchaTokenPoll = window.setInterval(completeCaptchaSubmission, 200);

      if (executeCaptchaWhenReady()) return;
      captchaBindingPoll = window.setInterval(executeCaptchaWhenReady, 100);
    };

    form?.addEventListener('submit', (event) => {
      event.preventDefault();
      requestSubmission();
    });
    form?.addEventListener('pdpPromoPopup:captchaReady', completeCaptchaSubmission);
    emailInput?.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.isComposing) return;
      event.preventDefault();
      if (isSubmitting || isAwaitingCaptcha) return;
      requestSubmission();
    });
    submitButton?.addEventListener('click', requestSubmission);

    initializeCapsule();

    if (hasSuccess) {
      writeStorage(window.localStorage, STORAGE_KEYS.subscriptionConfirmed, 'true');
      if (!isDesignMode) trackEvent('pdp_promo_email_success', eventParams);
      show({ record: false, trackView: false });
      popup.querySelector('[data-pdp-promo-success]')?.focus();
      return;
    }

    const permanentlyExcluded = !isDesignMode && isSubscriptionConfirmed();
    if (permanentlyExcluded) showSubmitSuccess();

    if (hasError || isDesignMode || isPreviewForced) {
      show({ record: false, trackView: false });
      return;
    }

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
