import {
  escapeHtml,
  formatDate,
  icon,
  openContentDialog,
  openFormDialog,
  showToast,
  statusBadge,
} from './components.js';

const appRoot = document.querySelector('#store-app');
const merchantCode = decodeURIComponent(location.pathname.split('/').filter(Boolean).at(-1) || '').toUpperCase();
const localOrderKey = `kmxt.store.orders.${merchantCode}`;
const state = {
  store: null,
  view: location.hash === '#orders' ? 'orders' : 'products',
  queryResult: null,
};

class StoreRequestError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function request(method, path, body) {
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: body === undefined ? { Accept: 'application/json' } : {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new StoreRequestError('NETWORK_ERROR', '无法连接订单服务。', 0);
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.success !== true) {
    throw new StoreRequestError(
      payload?.error?.code || 'REQUEST_FAILED',
      payload?.error?.message || '请求失败。',
      response.status,
    );
  }
  return payload.data;
}

function friendlyError(error) {
  const messages = {
    STOREFRONT_NOT_FOUND: '店铺不存在或已停止服务。',
    PRODUCT_UNAVAILABLE: '该套餐当前不可提交。',
    ORDER_QUERY_INVALID: '订单号或查询码不正确。',
    INVALID_INPUT: '提交内容格式不正确，请检查填写内容。',
    RATE_LIMITED: '操作过于频繁，请稍后重试。',
    NETWORK_ERROR: '无法连接订单服务。',
  };
  return messages[error.code] || error.message || '操作失败。';
}

function readLocalOrders() {
  try {
    const value = JSON.parse(localStorage.getItem(localOrderKey) || '[]');
    return Array.isArray(value) ? value.slice(0, 10) : [];
  } catch {
    return [];
  }
}

function saveLocalOrder(order) {
  try {
    const current = readLocalOrders().filter((item) => item.orderNo !== order.orderNo);
    localStorage.setItem(localOrderKey, JSON.stringify([order, ...current].slice(0, 10)));
    return true;
  } catch {
    return false;
  }
}

function formatPrice(cents) {
  if (cents === 0) {
    return '<strong>人工确认</strong>';
  }
  return `<small>¥</small><strong>${(cents / 100).toFixed(2)}</strong>`;
}

function deviceLimitText(value) {
  return Number(value) === 0 ? '无限制设备' : `最多 ${value} 台设备`;
}

function setView(view) {
  state.view = view;
  location.hash = view === 'orders' ? 'orders' : 'products';
  document.querySelectorAll('[data-store-view]').forEach((button) => {
    const active = button.dataset.storeView === view;
    button.classList.toggle('active', active);
    button.setAttribute('aria-current', active ? 'page' : 'false');
  });
  render();
}

function renderProducts() {
  const products = state.store.products;
  const cards = products.map((product) => `<article class="product-card">
    <span class="product-app">${escapeHtml(product.application.name)}</span>
    <h2>${escapeHtml(product.name)}</h2>
    <p class="product-description">${escapeHtml(product.description || '授权套餐')}</p>
    <div class="product-price">${formatPrice(product.priceCents)}</div>
    <ul class="product-facts">
      <li>${icon('clock-3')}<span>激活后 ${product.durationDays} 天</span></li>
      <li>${icon('monitor-smartphone')}<span>${deviceLimitText(product.maxDevices)}</span></li>
      <li>${icon('package-check')}<span>商户审核后发放</span></li>
    </ul>
    <button class="button" type="button" data-action="order-product" data-id="${escapeHtml(product.id)}">提交订单</button>
  </article>`).join('');
  return `<header class="store-page-header">
      <div><h1>${escapeHtml(state.store.merchant.name)}</h1><p>授权套餐</p></div>
      <span class="store-status">${icon('shield-check')}人工审核发放</span>
    </header>
    ${cards ? `<section class="product-grid" aria-label="套餐列表">${cards}</section>` : `<div class="store-empty">${icon('shopping-bag')}<h2>暂无可用套餐</h2></div>`}`;
}

function renderOrderResult(order) {
  if (!order) {
    return `<section class="order-result placeholder">${icon('receipt-text')}<p>输入订单号和查询码</p></section>`;
  }
  const statusText = { pending: '等待商户处理', fulfilled: '卡密已发放', rejected: '订单已拒绝' }[order.status] || order.status;
  return `<section class="order-result">
    <div class="section-header"><h2>订单结果</h2>${statusBadge(order.status, statusText)}</div>
    <div class="order-summary">
      <div><small>订单号</small><strong class="mono">${escapeHtml(order.orderNo)}</strong></div>
      <div><small>当前状态</small><strong>${escapeHtml(statusText)}</strong></div>
      <div><small>套餐</small><strong>${escapeHtml(order.product.name)}</strong></div>
      <div><small>提交时间</small><strong>${formatDate(order.createdAt)}</strong></div>
    </div>
    ${order.status === 'fulfilled' ? `<div class="license-delivery"><span class="field-label">卡密</span><div class="license-line"><code>${escapeHtml(order.licenseKey)}</code><button class="icon-button" type="button" data-action="copy-license" data-value="${escapeHtml(order.licenseKey)}" aria-label="复制卡密" title="复制卡密">${icon('copy')}</button></div></div>` : ''}
    ${order.status === 'rejected' ? `<div class="form-error visible">${escapeHtml(order.rejectReason || '订单未通过审核。')}</div>` : ''}
  </section>`;
}

function renderOrders() {
  const localOrders = readLocalOrders();
  const localItems = localOrders.map((order) => `<div class="local-order-item">
    <span><strong class="mono">${escapeHtml(order.orderNo)}</strong><small>${escapeHtml(order.productName)} · ${formatDate(order.createdAt)}</small></span>
    <button class="button secondary small" type="button" data-action="query-local-order" data-order-no="${escapeHtml(order.orderNo)}" data-query-code="${escapeHtml(order.queryCode)}">查询</button>
  </div>`).join('');
  return `<header class="store-page-header"><div><h1>订单查询</h1><p>${escapeHtml(state.store.merchant.name)}</p></div></header>
    <div class="order-layout">
      <section class="order-query-panel">
        <h2>查询凭证</h2>
        <form class="form-stack" id="order-query-form">
          <div class="field"><label for="query-order-no">订单号</label><input class="input mono" id="query-order-no" name="orderNo" minlength="10" maxlength="40" required></div>
          <div class="field"><label for="query-code">查询码</label><textarea class="textarea mono" id="query-code" name="queryCode" minlength="20" maxlength="128" required></textarea></div>
          <div class="form-error" id="query-error" role="alert"></div>
          <button class="button" type="submit">查询订单</button>
        </form>
      </section>
      ${renderOrderResult(state.queryResult)}
      ${localItems ? `<section class="local-orders"><h2>本机订单</h2><div class="local-order-list">${localItems}</div></section>` : ''}
    </div>`;
}

function render() {
  if (!state.store) return;
  appRoot.innerHTML = state.view === 'orders' ? renderOrders() : renderProducts();
}

function openOrderForm(product) {
  openFormDialog({
    title: product.name,
    submitLabel: '提交订单',
    content: `<div class="form-stack">
      <div class="order-summary">
        <div><small>授权时长</small><strong>${product.durationDays} 天</strong></div>
        <div><small>设备上限</small><strong>${deviceLimitText(product.maxDevices)}</strong></div>
      </div>
      <div class="field"><label for="customer-name">称呼（选填）</label><input class="input" id="customer-name" name="customerName" minlength="1" maxlength="80" autofocus></div>
      <div class="field"><label for="customer-contact">联系方式</label><input class="input" id="customer-contact" name="contact" minlength="3" maxlength="120" autocomplete="email" required></div>
      <div class="field"><label for="customer-note">备注（选填）</label><textarea class="textarea" id="customer-note" name="note" maxlength="500"></textarea></div>
    </div>`,
    onSubmit: async (form) => {
      let order;
      try {
        order = await request('POST', `/api/v1/store/${encodeURIComponent(merchantCode)}/orders`, {
          productId: product.id,
          customerName: form.get('customerName') || undefined,
          contact: form.get('contact'),
          note: form.get('note') || undefined,
        });
      } catch (error) {
        throw new Error(friendlyError(error));
      }
      const savedLocally = saveLocalOrder({
        orderNo: order.orderNo,
        queryCode: order.queryCode,
        productName: product.name,
        createdAt: order.createdAt,
      });
      window.setTimeout(() => showOrderCreated(order, savedLocally), 0);
    },
  });
}

function showOrderCreated(order, savedLocally) {
  const dialog = openContentDialog({
    title: '订单已提交',
    content: `<div class="order-created">
      <div class="field"><span class="field-label">订单号</span><code class="mono">${escapeHtml(order.orderNo)}</code></div>
      <div class="field"><label for="created-query-code">查询码</label><textarea class="query-secret" id="created-query-code" readonly>${escapeHtml(order.queryCode)}</textarea></div>
      ${savedLocally ? '' : '<div class="form-error visible">浏览器未保存本机记录，请立即复制订单凭证。</div>'}
    </div>`,
    footer: `<button class="button secondary" type="button" data-created-action="copy">${icon('copy')}复制凭证</button><button class="button" type="button" data-created-action="query">查询订单</button>`,
  });
  dialog.addEventListener('click', async (event) => {
    const action = event.target.closest('[data-created-action]')?.dataset.createdAction;
    if (action === 'copy') {
      await copyText(`订单号：${order.orderNo}\n查询码：${order.queryCode}`);
      showToast('订单凭证已复制。');
    }
    if (action === 'query') {
      dialog.close();
      setView('orders');
      await queryOrder(order.orderNo, order.queryCode);
    }
  });
}

async function copyText(value) {
  if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Fall back to a temporary selection when clipboard permission is unavailable.
    }
  }
  const textarea = document.createElement('textarea');
  textarea.value = value;
  document.body.append(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

async function queryOrder(orderNo, queryCode) {
  const errorBox = document.querySelector('#query-error');
  try {
    state.queryResult = await request('POST', '/api/v1/store/orders/query', { orderNo, queryCode });
    render();
    const orderInput = document.querySelector('#query-order-no');
    const codeInput = document.querySelector('#query-code');
    if (orderInput) orderInput.value = orderNo;
    if (codeInput) codeInput.value = queryCode;
  } catch (error) {
    if (errorBox) {
      errorBox.textContent = friendlyError(error);
      errorBox.classList.add('visible');
    } else {
      showToast(friendlyError(error), 'error');
    }
  }
}

document.addEventListener('click', async (event) => {
  const viewButton = event.target.closest('[data-store-view]');
  if (viewButton) {
    setView(viewButton.dataset.storeView);
    return;
  }
  const button = event.target.closest('[data-action]');
  if (!button) return;
  if (button.dataset.action === 'order-product') {
    const product = state.store.products.find((item) => item.id === button.dataset.id);
    if (product) openOrderForm(product);
  } else if (button.dataset.action === 'query-local-order') {
    setView('orders');
    await queryOrder(button.dataset.orderNo, button.dataset.queryCode);
  } else if (button.dataset.action === 'copy-license') {
    await copyText(button.dataset.value);
    showToast('卡密已复制。');
  }
});

document.addEventListener('submit', async (event) => {
  if (event.target.id !== 'order-query-form') return;
  event.preventDefault();
  const form = new FormData(event.target);
  const button = event.target.querySelector('button[type="submit"]');
  button.disabled = true;
  button.innerHTML = '<span class="button-spinner" aria-hidden="true"></span><span>查询中</span>';
  await queryOrder(String(form.get('orderNo')).trim(), String(form.get('queryCode')).trim());
  if (document.body.contains(button)) {
    button.disabled = false;
    button.textContent = '查询订单';
  }
});

window.addEventListener('hashchange', () => {
  const view = location.hash === '#orders' ? 'orders' : 'products';
  if (view !== state.view) {
    state.view = view;
    document.querySelectorAll('[data-store-view]').forEach((button) => {
      const active = button.dataset.storeView === view;
      button.classList.toggle('active', active);
      button.setAttribute('aria-current', active ? 'page' : 'false');
    });
    render();
  }
});

async function bootstrap() {
  try {
    state.store = await request('GET', `/api/v1/store/${encodeURIComponent(merchantCode)}`);
    document.title = `${state.store.merchant.name} · 授权套餐`;
    document.querySelector('#store-name').textContent = state.store.merchant.name;
    document.querySelector('#store-code').textContent = state.store.merchant.code;
    setView(state.view);
  } catch (error) {
    appRoot.innerHTML = `<div class="store-error">${icon('alert-triangle')}<h1>店铺不可用</h1><p>${escapeHtml(friendlyError(error))}</p></div>`;
  }
}

bootstrap();
