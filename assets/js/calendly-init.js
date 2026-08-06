/* Shared Calendly popup trigger — used identically on every page. */
var CALENDLY_URL = 'https://calendly.com/nexoracreativestudio/aesthetic-demo';

function openCalendlyPopup() {
  if (window.Calendly && typeof window.Calendly.initPopupWidget === 'function') {
    window.Calendly.initPopupWidget({ url: CALENDLY_URL });
  } else {
    // Calendly widget script hasn't finished loading yet — fall back gracefully
    window.open(CALENDLY_URL, '_blank', 'noopener');
  }
  return false;
}
