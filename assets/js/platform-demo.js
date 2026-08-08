/* Interactive Platform Demo — click/tap/keyboard step-through.
   No autoplay. Vanilla JS only. Follows the WAI-ARIA tabs pattern
   for keyboard support (Left/Right/Home/End to move focus, native
   button activation via Enter/Space/click). */
(function () {
  var tablist = document.getElementById('platform-demo-tabs');
  if (!tablist) return;

  var tabs = Array.prototype.slice.call(tablist.querySelectorAll('.demo-tab'));
  var titleEl = document.getElementById('demo-step-title');

  function activate(tab, focus) {
    tabs.forEach(function (t) {
      var selected = t === tab;
      t.classList.toggle('is-active', selected);
      t.setAttribute('aria-selected', selected ? 'true' : 'false');
      t.tabIndex = selected ? 0 : -1;
      var panel = document.getElementById(t.getAttribute('aria-controls'));
      if (panel) panel.hidden = !selected;
    });
    if (titleEl) {
      var step = tab.getAttribute('data-step');
      titleEl.textContent = step + '. ' + tab.textContent.replace(/^\d+\s*·\s*/, '');
    }
    if (focus) tab.focus();
  }

  tabs.forEach(function (tab, i) {
    tab.addEventListener('click', function () {
      activate(tab, false);
    });
    tab.addEventListener('keydown', function (e) {
      var next = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        next = tabs[(i + 1) % tabs.length];
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        next = tabs[(i - 1 + tabs.length) % tabs.length];
      } else if (e.key === 'Home') {
        next = tabs[0];
      } else if (e.key === 'End') {
        next = tabs[tabs.length - 1];
      }
      if (next) {
        e.preventDefault();
        activate(next, true);
      }
    });
  });
})();
