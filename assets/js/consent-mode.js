(function () {
  'use strict';

  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function () {
    window.dataLayer.push(arguments);
  };

  /* ---- i18n: consent banner text by language ---- */
  var consentI18n = {
    en: {
      text: 'We use analytics cookies to understand how visitors use our website.',
      reject: 'Reject analytics',
      accept: 'Accept analytics'
    },
    de: {
      text: 'Wir verwenden Analyse-Cookies, um zu verstehen, wie Besucher unsere Website nutzen.',
      reject: 'Analyse ablehnen',
      accept: 'Analyse akzeptieren'
    }
  };

  var lang = (document.documentElement.lang || 'en').toLowerCase();
  var t = consentI18n[lang] || consentI18n.en;

  var stored = localStorage.getItem('nexora_analytics_consent');

  gtag('consent', 'default', {
    analytics_storage: stored === 'granted' ? 'granted' : 'denied',
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied'
  });

  function updateConsent(value) {
    localStorage.setItem('nexora_analytics_consent', value);

    gtag('consent', 'update', {
      analytics_storage: value,
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied'
    });

    var banner = document.getElementById('cookie-consent-banner');
    if (banner) banner.remove();
  }

  if (!stored) {
    document.addEventListener('DOMContentLoaded', function () {
      var banner = document.createElement('div');
      banner.id = 'cookie-consent-banner';

      banner.innerHTML =
        '<div class="cookie-consent-inner">' +
          '<p>' + t.text + '</p>' +
          '<div class="cookie-consent-actions">' +
            '<button type="button" data-consent="denied">' + t.reject + '</button>' +
            '<button type="button" data-consent="granted">' + t.accept + '</button>' +
          '</div>' +
        '</div>';

      document.body.appendChild(banner);

      banner.addEventListener('click', function (event) {
        var button = event.target.closest('[data-consent]');
        if (!button) return;
        updateConsent(button.getAttribute('data-consent'));
      });
    });
  }
})();
