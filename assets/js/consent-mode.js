(function () {
  'use strict';

  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function () {
    window.dataLayer.push(arguments);
  };

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
          '<p>We use analytics cookies to understand how visitors use our website.</p>' +
          '<div class="cookie-consent-actions">' +
            '<button type="button" data-consent="denied">Reject analytics</button>' +
            '<button type="button" data-consent="granted">Accept analytics</button>' +
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
