import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const files = await Promise.all([
  readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../public/store.html', import.meta.url), 'utf8'),
  readFile(new URL('../public/js/app.js', import.meta.url), 'utf8'),
  readFile(new URL('../public/js/store.js', import.meta.url), 'utf8'),
  readFile(new URL('../public/js/theme-init.js', import.meta.url), 'utf8'),
  readFile(new URL('../public/js/theme.js', import.meta.url), 'utf8'),
  readFile(new URL('../public/styles.css', import.meta.url), 'utf8'),
  readFile(new URL('../public/assets/icons.svg', import.meta.url), 'utf8'),
]);

const [adminHtml, storeHtml, adminJs, storeJs, themeInit, themeModule, styles, icons] = files;

test('theme initialization runs before styles on admin and storefront pages', () => {
  for (const html of [adminHtml, storeHtml]) {
    assert.ok(html.indexOf('/admin/js/theme-init.js') > 0);
    assert.ok(html.indexOf('/admin/js/theme-init.js') < html.indexOf('/admin/styles.css'));
    assert.match(html, /name="color-scheme" content="light dark"/);
  }
});

test('theme controls persist and expose accessible light/dark state', () => {
  assert.match(themeInit, /localStorage\.getItem\(storageKey\)/);
  assert.match(themeModule, /localStorage\.setItem\(STORAGE_KEY, theme\)/);
  assert.match(themeModule, /aria-pressed/);
  assert.match(themeModule, /切换到白天模式/);
  assert.match(themeModule, /切换到黑夜模式/);
  assert.match(adminJs, /data-theme-toggle/);
  assert.match(adminJs, /toggleTheme\(\)/);
  assert.match(storeHtml, /data-theme-toggle/);
  assert.match(storeJs, /toggleTheme\(\)/);
});

test('dark theme defines semantic colors and matching SVG icons', () => {
  assert.match(styles, /html\[data-theme="dark"\]/);
  assert.match(styles, /--canvas: #0b1210/);
  assert.match(styles, /--text: #f1f7f4/);
  assert.match(styles, /--row-hover: #193027/);
  assert.match(styles, /tbody tr:hover\s*{\s*background: var\(--row-hover\)/);
  assert.match(styles, /animation: tableAccentFlow 4\.8s linear infinite/);
  assert.match(icons, /id="moon"/);
  assert.match(icons, /id="sun"/);
});
