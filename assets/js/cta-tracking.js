(function () {
  'use strict';

  document.addEventListener('click', function (event) {
    var link = event.target.closest('a[href]');
    if (!link || typeof window.gtag !== 'function') return;

    var href = link.getAttribute('href') || '';
    var eventName = null;

    if (href.indexOf('calendly.com') !== -1) {
      eventName = 'book_demo_click';
    } else if (href.indexOf('wa.me') !== -1) {
      eventName = 'whatsapp_click';
    } else if (href.indexOf('tel:') === 0) {
      eventName = 'phone_click';
    } else if (href.indexOf('mailto:') === 0) {
      eventName = 'email_click';
    }

    if (eventName) {
      window.gtag('event', eventName);
    }
  });
})();
