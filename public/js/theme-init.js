(function initializeTheme() {
  const storageKey = 'kmxt.theme';
  let theme = '';

  try {
    theme = localStorage.getItem(storageKey) || '';
  } catch {
    // Storage can be unavailable in hardened browser contexts.
  }

  if (theme !== 'light' && theme !== 'dark') {
    theme = window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute(
    'content',
    theme === 'dark' ? '#0b1210' : '#eef2f1',
  );
}());
