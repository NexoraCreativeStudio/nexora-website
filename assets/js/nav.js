/* Shared mobile navigation menu — accessible, keyboard-operable, used on every page. */
(function () {
  const toggleBtn = document.getElementById('navToggle');
  const menu = document.getElementById('mobileMenu');
  if (!toggleBtn || !menu) return;

  function openMenu() {
    menu.classList.add('open');
    toggleBtn.setAttribute('aria-expanded', 'true');
    document.body.classList.add('menu-open'); // full-screen panel: lock background scroll
    const firstLink = menu.querySelector('a, button');
    if (firstLink) firstLink.focus();
  }

  function closeMenu() {
    menu.classList.remove('open');
    toggleBtn.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('menu-open');
    toggleBtn.focus();
  }

  function isOpen() {
    return menu.classList.contains('open');
  }

  toggleBtn.addEventListener('click', () => {
    if (isOpen()) {
      closeMenu();
    } else {
      openMenu();
    }
  });

  // Close after selecting a navigation item
  menu.querySelectorAll('a, button.menu-cta').forEach((el) => {
    el.addEventListener('click', () => {
      closeMenu();
    });
  });

  // Escape closes the menu and returns focus to the toggle button
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) {
      closeMenu();
    }
  });
})();

/* Shared desktop dropdown nav (Phase 2) — isolated, does not touch mobile menu logic. */
(function () {
  const dropdowns = document.querySelectorAll('.nav-dropdown');
  if (!dropdowns.length) return;

  dropdowns.forEach((dd) => {
    const btn = dd.querySelector('.nav-dropdown-toggle');
    const menu = dd.querySelector('.nav-dropdown-menu');
    if (!btn || !menu) return;

    function open() {
      dd.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
    }
    function close() {
      dd.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
    }
    function isOpen() {
      return dd.classList.contains('open');
    }

    // Open on click (sole desktop interaction — click-to-toggle,
    // not hover, to avoid the gap between button and menu causing
    // the dropdown to close before the pointer reaches it)
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      isOpen() ? close() : open();
    });

    // Close when focus leaves the dropdown entirely (Tab navigation)
    dd.addEventListener('focusout', (e) => {
      if (!dd.contains(e.relatedTarget)) {
        close();
      }
    });

    // Close after selecting a destination
    menu.querySelectorAll('a').forEach((a) => {
      a.addEventListener('click', close);
    });

    // Store references for the document-level Escape handler below
    dd._close = close;
    dd._isOpen = isOpen;
    dd._btn = btn;
  });

  // Escape closes any open dropdown and returns focus to its toggle button.
  // Handled at document level (not scoped to focus-within-dropdown) so it
  // works reliably regardless of exactly which element currently has focus.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    dropdowns.forEach((dd) => {
      if (dd._isOpen && dd._isOpen()) {
        dd._close();
        dd._btn.focus();
      }
    });
  });

  // Close any open dropdown on outside click
  document.addEventListener('click', (e) => {
    dropdowns.forEach((dd) => {
      if (!dd.contains(e.target)) {
        dd.classList.remove('open');
        const btn = dd.querySelector('.nav-dropdown-toggle');
        if (btn) btn.setAttribute('aria-expanded', 'false');
      }
    });
  });
})();
