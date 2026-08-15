import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [storeHtml, storeJs, storeCss, storeBackgroundJs] = await Promise.all([
  readFile(new URL('../public/store.html', import.meta.url), 'utf8'),
  readFile(new URL('../public/js/store.js', import.meta.url), 'utf8'),
  readFile(new URL('../public/store.css', import.meta.url), 'utf8'),
  readFile(new URL('../public/js/store-background.js', import.meta.url), 'utf8'),
]);

test('storefront product page presents plans and trust details', () => {
  assert.match(storeJs, /class="store-hero"/);
  assert.match(storeJs, /选择适合你的授权方案/);
  assert.match(storeJs, /class="store-trust-row"/);
  assert.match(storeJs, /class="product-price-block"/);
});

test('storefront layout supports single-plan desktop and responsive mobile cards', () => {
  assert.match(storeJs, /products\.length === 1 \? ' single'/);
  assert.match(storeCss, /\.product-card\.single/);
  assert.match(storeCss, /grid-template-columns: minmax\(0, 820px\)/);
  assert.match(storeCss, /grid-template-columns: repeat\(auto-fit/);
  assert.match(storeCss, /minmax\(min\(100%, 280px\), 380px\)/);
  assert.match(storeCss, /@media \(max-width: 620px\)/);
  assert.match(storeCss, /\.product-card, \.product-card\.single/);
});

test('product cards use an animated green accent without forcing motion', () => {
  assert.match(storeCss, /\.product-card::before/);
  assert.match(storeCss, /animation: productAccentFlow 4\.8s linear infinite/);
  assert.match(storeCss, /@keyframes productAccentFlow/);
});

test('storefront background renders a reduced-motion aware abstract 3d joint network', () => {
  assert.match(storeHtml, /data-store-joint-network/);
  assert.match(storeJs, /mountStoreJointNetwork/);
  assert.match(storeCss, /\.store-joint-network/);
  assert.match(storeBackgroundJs, /const JOINTS/);
  assert.match(storeBackgroundJs, /const BONES/);
  assert.match(storeBackgroundJs, /prefers-reduced-motion: reduce/);
  assert.match(storeBackgroundJs, /visibilitychange/);
});
