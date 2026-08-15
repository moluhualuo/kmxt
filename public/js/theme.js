const STORAGE_KEY = 'kmxt.theme';
const THEMES = new Set(['light', 'dark']);

function storedTheme() {
  try {
    return localStorage.getItem(STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function preferredTheme() {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function getTheme() {
  const current = document.documentElement.dataset.theme;
  if (THEMES.has(current)) return current;
  const stored = storedTheme();
  return THEMES.has(stored) ? stored : preferredTheme();
}

function updateThemeColor(theme) {
  document.querySelector('meta[name="theme-color"]')?.setAttribute(
    'content',
    theme === 'dark' ? '#0b1210' : '#eef2f1',
  );
}

export function syncThemeControls(root = document) {
  const dark = getTheme() === 'dark';
  const label = dark ? '切换到白天模式' : '切换到黑夜模式';
  const iconName = dark ? 'sun' : 'moon';

  root.querySelectorAll('[data-theme-toggle]').forEach((button) => {
    button.setAttribute('aria-label', label);
    button.setAttribute('title', label);
    button.setAttribute('aria-pressed', String(dark));
    const use = button.querySelector('use');
    use?.setAttribute('href', `/admin/assets/icons.svg#${iconName}`);
    const text = button.querySelector('[data-theme-label]');
    if (text) text.textContent = dark ? '白天模式' : '黑夜模式';
  });
}

export function setTheme(theme, { persist = true } = {}) {
  if (!THEMES.has(theme)) return;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  updateThemeColor(theme);

  if (persist) {
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // The active page still changes theme when persistence is unavailable.
    }
  }

  syncThemeControls();
  window.dispatchEvent(new CustomEvent('kmxt:themechange', { detail: { theme } }));
}

export function toggleTheme() {
  setTheme(getTheme() === 'dark' ? 'light' : 'dark');
}

syncThemeControls();
