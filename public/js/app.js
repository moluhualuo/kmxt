import { api, ApiError } from './api.js';
import {
  confirmAction,
  downloadText,
  emptyState,
  escapeHtml,
  formatDate,
  icon,
  openContentDialog,
  openFormDialog,
  pagination,
  roleLabel,
  showToast,
  statusBadge,
} from './components.js';
import { store } from './state.js';

const appRoot = document.querySelector('#app');
const VIEW_LABELS = Object.freeze({
  overview: ['总览', '授权业务概况'],
  merchants: ['商户', '平台租户管理'],
  applications: ['程序', '程序与授权策略'],
  licenses: ['卡密', '卡密与设备绑定'],
  products: ['商品', '用户购买套餐'],
  orders: ['订单', '人工审核与发卡'],
  users: ['账号', '商户账号与角色'],
  logs: ['日志', '管理与验证记录'],
});

let viewGeneration = 0;

function isPlatformAdmin() {
  return store.value.user?.role === 'platform_admin';
}

function isOwner() {
  return ['platform_admin', 'merchant_admin'].includes(store.value.user?.role);
}

function deviceLimitText(value) {
  return Number(value) === 0 ? '无限制' : `${value} 台`;
}

function friendlyError(error) {
  const messages = {
    INVALID_CREDENTIALS: '用户名或密码错误。',
    UNAUTHORIZED: '登录状态已失效，请重新登录。',
    FORBIDDEN: '当前账号没有执行此操作的权限。',
    MERCHANT_DISABLED: '当前商户已被禁用。',
    APPLICATION_DISABLED: '当前程序已被禁用。',
    LICENSE_EXPIRED: '卡密已到期。',
    DEVICE_LIMIT_REACHED: '卡密已达到设备数量上限。',
    ORDER_NOT_PENDING: '该订单已经处理。',
    PRODUCT_UNAVAILABLE: '该商品当前不可用。',
    CURRENT_PASSWORD_INVALID: '当前密码不正确。',
    PASSWORD_UNCHANGED: '新密码不能与原密码相同。',
    PASSWORD_CHANGED_RETRY: '密码已被其他请求修改，请重新登录后再试。',
    USE_SELF_PASSWORD_CHANGE: '请使用修改本人密码功能。',
    USER_NOT_FOUND: '账号不存在。',
    RATE_LIMITED: '请求过于频繁，请稍后重试。',
    NETWORK_ERROR: '无法连接授权服务，请检查服务状态。',
  };
  return messages[error?.code] || error?.message || '操作失败。';
}

function pageHeader(title, subtitle, actions = '') {
  return `<header class="page-header">
    <div>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(subtitle)}</p>
    </div>
    ${actions ? `<div class="page-actions">${actions}</div>` : ''}
  </header>`;
}

function navButton(view, iconName, label) {
  const active = store.value.view === view;
  return `<button class="nav-button ${active ? 'active' : ''}" type="button" data-view="${view}" ${active ? 'aria-current="page"' : ''}>
    ${icon(iconName)}<span>${escapeHtml(label)}</span>
  </button>`;
}

function renderLogin() {
  appRoot.innerHTML = `<main class="login-page" id="main-content">
    <section class="login-panel">
      <div class="login-brand">
        <img src="/admin/assets/brand.svg" width="42" height="42" alt="KMXT">
        <div><div class="brand-name">KMXT</div><div class="brand-caption">授权管理中心</div></div>
      </div>
      <h1>管理员登录</h1>
      <p class="login-subtitle">使用平台或商户账号进入管理中心</p>
      <form class="form-stack" id="login-form">
        <div class="field">
          <label for="login-username">用户名</label>
          <input class="input" id="login-username" name="username" autocomplete="username" minlength="3" maxlength="64" required autofocus>
        </div>
        <div class="field">
          <label for="login-password">密码</label>
          <input class="input" id="login-password" name="password" type="password" autocomplete="current-password" minlength="10" maxlength="128" required>
        </div>
        <div class="form-error" id="login-error" role="alert"></div>
        <button class="button" type="submit" id="login-submit">登录</button>
      </form>
    </section>
    <aside class="login-visual" aria-label="系统结构">
      <div class="system-map">
        <div class="map-node">${icon('building-2')}<strong>商户</strong></div>
        <div class="map-node primary">${icon('boxes')}<strong>程序</strong></div>
        <div class="map-node">${icon('shield-check')}<strong>授权</strong></div>
      </div>
    </aside>
  </main>`;

  document.querySelector('#login-form').addEventListener('submit', handleLogin);
}

async function handleLogin(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const button = document.querySelector('#login-submit');
  const errorBox = document.querySelector('#login-error');
  button.disabled = true;
  button.innerHTML = `<span class="button-spinner" aria-hidden="true"></span><span>正在登录</span>`;
  errorBox.classList.remove('visible');
  try {
    const result = await api.login(form.get('username'), form.get('password'));
    api.setToken(result.token);
    await initializeSession(result.user);
  } catch (error) {
    errorBox.textContent = friendlyError(error);
    errorBox.classList.add('visible');
  } finally {
    if (document.body.contains(button)) {
      button.disabled = false;
      button.textContent = '登录';
    }
  }
}

async function initializeSession(existingUser = null) {
  const user = existingUser || await api.get('/api/v1/auth/me');
  let merchants;
  if (user.role === 'platform_admin') {
    merchants = await api.get('/api/v1/platform/merchants');
  } else {
    merchants = [await api.get(`/api/v1/merchants/${encodeURIComponent(user.merchantId)}`)];
  }
  let selectedMerchantId = store.value.selectedMerchantId;
  if (!merchants.some((merchant) => merchant.id === selectedMerchantId)) {
    selectedMerchantId = merchants[0]?.id || null;
  }
  const applications = selectedMerchantId
    ? await api.get(`/api/v1/merchants/${encodeURIComponent(selectedMerchantId)}/apps`)
    : [];
  let selectedAppId = store.value.selectedAppId;
  if (!applications.some((application) => application.id === selectedAppId)) {
    selectedAppId = applications[0]?.id || null;
  }
  const requestedView = location.hash.replace(/^#\/?/, '');
  const allowedViews = availableViews(user).map((item) => item.id);
  const view = allowedViews.includes(requestedView) ? requestedView : 'overview';
  store.patch({
    user,
    merchants,
    applications,
    selectedMerchantId,
    selectedAppId,
    view,
    logMode: user.role === 'operator' ? 'verification' : store.value.logMode,
  });
  renderShell();
  await renderCurrentView();
}

function availableViews(user = store.value.user) {
  const items = [{ id: 'overview', icon: 'layout-dashboard', label: '总览' }];
  if (user?.role === 'platform_admin') {
    items.push({ id: 'merchants', icon: 'building-2', label: '商户' });
  }
  items.push(
    { id: 'applications', icon: 'boxes', label: '程序' },
    { id: 'licenses', icon: 'key-round', label: '卡密' },
    { id: 'products', icon: 'shopping-bag', label: '商品' },
    { id: 'orders', icon: 'receipt-text', label: '订单' },
  );
  if (['platform_admin', 'merchant_admin'].includes(user?.role)) {
    items.push({ id: 'users', icon: 'users', label: '账号' });
  }
  items.push({ id: 'logs', icon: 'scroll-text', label: '日志' });
  return items;
}

function renderShell() {
  const { user, merchants, selectedMerchantId, sidebarOpen } = store.value;
  const merchant = store.merchant;
  const title = VIEW_LABELS[store.value.view] || VIEW_LABELS.overview;
  const merchantControl = isPlatformAdmin()
    ? `<label class="field-label" for="merchant-context">商户</label>
      <select class="select context-select" id="merchant-context" aria-label="当前商户">
        ${merchants.length === 0 ? '<option value="">暂无商户</option>' : merchants.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === selectedMerchantId ? 'selected' : ''}>${escapeHtml(item.name)} · ${escapeHtml(item.code)}</option>`).join('')}
      </select>`
    : `<div class="topbar-title"><strong>${escapeHtml(merchant?.name || '商户')}</strong><span>${escapeHtml(merchant?.code || '')}</span></div>`;
  const initial = (user.displayName || user.username || 'A').trim().slice(0, 1).toUpperCase();

  appRoot.innerHTML = `<div class="app-shell">
    <aside class="sidebar ${sidebarOpen ? 'open' : ''}" aria-label="主要导航">
      <div class="sidebar-brand">
        <img src="/admin/assets/brand.svg" width="34" height="34" alt="">
        <div><strong>KMXT</strong><small>授权管理中心</small></div>
      </div>
      <nav class="sidebar-nav">
        ${availableViews().map((item) => navButton(item.id, item.icon, item.label)).join('')}
      </nav>
      <div class="sidebar-user">
        <div class="user-row">
          <span class="avatar" aria-hidden="true">${escapeHtml(initial)}</span>
          <div class="user-meta"><strong>${escapeHtml(user.displayName)}</strong><span>${escapeHtml(roleLabel(user.role))}</span></div>
          <div class="sidebar-user-actions">
            <button class="icon-button on-dark" type="button" data-action="change-password" aria-label="修改密码" title="修改密码">${icon('key-round')}</button>
            <button class="icon-button on-dark" type="button" data-action="logout" aria-label="退出登录" title="退出登录">${icon('log-out')}</button>
          </div>
        </div>
      </div>
    </aside>
    <button class="sidebar-backdrop ${sidebarOpen ? 'visible' : ''}" type="button" data-action="close-sidebar" aria-label="关闭导航"></button>
    <div class="main-shell">
      <header class="topbar">
        <button class="icon-button mobile-menu" type="button" data-action="toggle-sidebar" aria-label="打开导航" title="导航">${icon('menu')}</button>
        <div class="topbar-title"><strong>${escapeHtml(title[0])}</strong><span>${escapeHtml(title[1])}</span></div>
        <div class="inline-actions">${merchantControl}</div>
        <button class="icon-button" type="button" data-action="refresh" aria-label="刷新当前页面" title="刷新">${icon('refresh-cw')}</button>
      </header>
      <div class="busy-bar" id="busy-bar" hidden></div>
      <main class="content" id="main-content"></main>
    </div>
  </div>`;
}

function setBusy(busy) {
  store.patch({ busy });
  const bar = document.querySelector('#busy-bar');
  if (bar) {
    bar.hidden = !busy;
  }
}

function renderLoading() {
  const main = document.querySelector('#main-content');
  if (main) {
    main.innerHTML = `<div class="empty-state">${icon('refresh-cw')}<h3>正在加载</h3></div>`;
  }
}

async function renderCurrentView() {
  const generation = ++viewGeneration;
  const main = document.querySelector('#main-content');
  if (!main) {
    return;
  }
  renderLoading();
  setBusy(true);
  try {
    let html;
    switch (store.value.view) {
      case 'merchants': html = await renderMerchants(); break;
      case 'applications': html = await renderApplications(); break;
      case 'licenses': html = await renderLicenses(); break;
      case 'products': html = await renderProducts(); break;
      case 'orders': html = await renderOrders(); break;
      case 'users': html = await renderUsers(); break;
      case 'logs': html = await renderLogs(); break;
      default: html = await renderOverview();
    }
    if (generation === viewGeneration && document.body.contains(main)) {
      main.innerHTML = html;
    }
  } catch (error) {
    if (generation === viewGeneration && error.status !== 401) {
      main.innerHTML = emptyState('alert-triangle', '加载失败', friendlyError(error), `<button class="button secondary" type="button" data-action="refresh">${icon('refresh-cw')}重试</button>`);
    }
  } finally {
    if (generation === viewGeneration) {
      setBusy(false);
    }
  }
}

async function renderOverview() {
  const merchant = store.merchant;
  const application = store.application;
  let licenseTotal = 0;
  let recentVerification = [];
  if (application) {
    const [licenses, logs] = await Promise.all([
      api.get(`/api/v1/apps/${encodeURIComponent(application.id)}/licenses?page=1&limit=1`),
      api.get(`/api/v1/apps/${encodeURIComponent(application.id)}/verification-logs?page=1&limit=5`),
    ]);
    licenseTotal = licenses.total;
    recentVerification = logs.items;
  }
  const actions = isPlatformAdmin() && !merchant
    ? `<button class="button" type="button" data-action="create-merchant">${icon('plus')}新建商户</button>`
    : `<button class="button" type="button" data-action="create-app" ${merchant ? '' : 'disabled'}>${icon('plus')}新建程序</button>`;
  const recentRows = recentVerification.map((entry) => `<tr>
    <td class="cell-primary">${escapeHtml(entry.event === 'activate' ? '激活' : '心跳')}</td>
    <td><span class="mono">${escapeHtml(entry.licenseId.slice(0, 8))}</span></td>
    <td>${escapeHtml(entry.clientVersion || '-')}</td>
    <td>${formatDate(entry.createdAt)}</td>
  </tr>`).join('');

  return `${pageHeader('业务总览', merchant ? merchant.name : '平台范围', actions)}
    <section class="metrics-grid" aria-label="业务指标">
      <article class="metric-card"><div><small>商户</small><div class="metric-value">${isPlatformAdmin() ? store.value.merchants.length : merchant ? 1 : 0}</div></div><span class="metric-icon">${icon('building-2')}</span></article>
      <article class="metric-card"><div><small>程序</small><div class="metric-value">${store.value.applications.length}</div></div><span class="metric-icon info">${icon('boxes')}</span></article>
      <article class="metric-card"><div><small>当前程序卡密</small><div class="metric-value">${licenseTotal}</div></div><span class="metric-icon">${icon('key-round')}</span></article>
      <article class="metric-card"><div><small>当前程序</small><div class="metric-value">${application ? statusBadge(application.status) : '-'}</div></div><span class="metric-icon info">${icon('shield-check')}</span></article>
    </section>
    <section class="section">
      <div class="section-header"><h2>最近验证</h2>${application ? `<span class="cell-secondary">${escapeHtml(application.name)}</span>` : ''}</div>
      <div class="table-frame">
        ${application && recentRows ? `<div class="table-scroll"><table><thead><tr><th>事件</th><th>卡密 ID</th><th>客户端版本</th><th>时间</th></tr></thead><tbody>${recentRows}</tbody></table></div>` : emptyState('scroll-text', '暂无验证记录', application ? '当前程序尚无验证记录。' : '请先创建或选择程序。')}
      </div>
    </section>`;
}

async function renderMerchants() {
  const rows = store.value.merchants.map((merchant) => `<tr>
    <td><span class="cell-primary">${escapeHtml(merchant.name)}</span><span class="cell-secondary mono">${escapeHtml(merchant.id.slice(0, 8))}</span></td>
    <td class="mono">${escapeHtml(merchant.code)}</td>
    <td>${statusBadge(merchant.status)}</td>
    <td>${formatDate(merchant.createdAt)}</td>
    <td><div class="inline-actions">
      <button class="button secondary small" type="button" data-action="select-merchant" data-id="${escapeHtml(merchant.id)}">进入</button>
      <button class="icon-button" type="button" data-action="toggle-merchant" data-id="${escapeHtml(merchant.id)}" data-status="${escapeHtml(merchant.status)}" aria-label="${merchant.status === 'active' ? '禁用' : '启用'}商户" title="${merchant.status === 'active' ? '禁用' : '启用'}">${icon(merchant.status === 'active' ? 'ban' : 'circle-check')}</button>
    </div></td>
  </tr>`).join('');
  return `${pageHeader('商户', '平台租户管理', `<button class="button" type="button" data-action="create-merchant">${icon('plus')}新建商户</button>`)}
    <div class="table-frame">
      ${rows ? `<div class="table-scroll"><table><thead><tr><th>商户</th><th>代码</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div>` : emptyState('building-2', '暂无商户', '创建第一个商户后即可配置程序。', `<button class="button" type="button" data-action="create-merchant">${icon('plus')}新建商户</button>`)}
    </div>`;
}

async function renderApplications() {
  const merchant = store.merchant;
  if (!merchant) {
    return `${pageHeader('程序', '程序与授权策略')}${emptyState('boxes', '未选择商户', '请先创建或选择商户。')}`;
  }
  const rows = store.value.applications.map((application) => `<tr>
    <td><span class="cell-primary">${escapeHtml(application.name)}</span><span class="cell-secondary mono">${escapeHtml(application.id.slice(0, 8))}</span></td>
    <td class="mono">${escapeHtml(application.code)}</td>
    <td>${statusBadge(application.status)}</td>
    <td>${application.settings.defaultDurationDays} 天 / ${deviceLimitText(application.settings.defaultMaxDevices)}</td>
    <td>${application.settings.heartbeatSeconds} 秒</td>
    <td><div class="inline-actions">
      <button class="button secondary small" type="button" data-action="select-app" data-id="${escapeHtml(application.id)}">卡密</button>
      <button class="button secondary small" type="button" data-action="download-client-config" data-format="json" data-id="${escapeHtml(application.id)}" data-code="${escapeHtml(application.code)}">JSON</button>
      <button class="button secondary small" type="button" data-action="download-client-config" data-format="hpp" data-id="${escapeHtml(application.id)}" data-code="${escapeHtml(application.code)}">HPP</button>
      ${isOwner() ? `<button class="icon-button" type="button" data-action="toggle-app" data-id="${escapeHtml(application.id)}" data-status="${escapeHtml(application.status)}" aria-label="${application.status === 'active' ? '禁用' : '启用'}程序" title="${application.status === 'active' ? '禁用' : '启用'}">${icon(application.status === 'active' ? 'ban' : 'circle-check')}</button>` : ''}
    </div></td>
  </tr>`).join('');
  const createButton = isOwner()
    ? `<button class="button" type="button" data-action="create-app">${icon('plus')}新建程序</button>`
    : '';
  return `${pageHeader('程序', merchant.name, createButton)}
    <div class="table-frame">
      ${rows ? `<div class="table-scroll"><table><thead><tr><th>程序</th><th>代码</th><th>状态</th><th>默认授权</th><th>心跳</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div>` : emptyState('boxes', '暂无程序', '当前商户还没有程序。', createButton)}
    </div>`;
}

async function renderLicenses() {
  const application = store.application;
  const appSelector = `<select class="select" id="license-app-context" aria-label="当前程序">
    ${store.value.applications.length ? store.value.applications.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === store.value.selectedAppId ? 'selected' : ''}>${escapeHtml(item.name)} · ${escapeHtml(item.code)}</option>`).join('') : '<option value="">暂无程序</option>'}
  </select>`;
  if (!application) {
    return `${pageHeader('卡密', '卡密与设备绑定')}${emptyState('key-round', '暂无程序', '请先创建程序。', isOwner() ? `<button class="button" type="button" data-view="applications">${icon('plus')}新建程序</button>` : '')}`;
  }
  const query = new URLSearchParams({ page: String(store.value.licensePage), limit: '20' });
  if (store.value.licenseStatus) query.set('status', store.value.licenseStatus);
  if (store.value.licenseSearch) query.set('key', store.value.licenseSearch);
  const data = await api.get(`/api/v1/apps/${encodeURIComponent(application.id)}/licenses?${query}`);
  const rows = data.items.map((license) => `<tr>
    <td><span class="cell-primary mono">${escapeHtml(license.keyPreview)}</span><span class="cell-secondary mono">${escapeHtml(license.id.slice(0, 8))}</span></td>
    <td>${statusBadge(license.status)}</td>
    <td>${license.durationDays ? `${license.durationDays} 天` : formatDate(license.fixedExpiresAt, { dateOnly: true })}</td>
    <td>${deviceLimitText(license.maxDevices)}</td>
    <td>${formatDate(license.expiresAt)}</td>
    <td><div class="inline-actions">
      <button class="icon-button" type="button" data-action="show-devices" data-id="${escapeHtml(license.id)}" aria-label="查看设备" title="设备">${icon('monitor-smartphone')}</button>
      ${license.status !== 'expired' ? `<button class="icon-button" type="button" data-action="toggle-license" data-id="${escapeHtml(license.id)}" data-status="${escapeHtml(license.status)}" aria-label="${license.status === 'disabled' ? '启用' : '禁用'}卡密" title="${license.status === 'disabled' ? '启用' : '禁用'}">${icon(license.status === 'disabled' ? 'circle-check' : 'ban')}</button>` : ''}
    </div></td>
  </tr>`).join('');
  return `${pageHeader('卡密', application.name, `<button class="button" type="button" data-action="generate-licenses" ${application.status === 'active' ? '' : 'disabled'}>${icon('plus')}生成卡密</button>`)}
    <div class="toolbar section-header">
      <div class="inline-actions">${appSelector}
        <select class="select" id="license-status-filter" aria-label="卡密状态">
          <option value="">全部状态</option>
          ${['pending', 'active', 'disabled', 'expired'].map((status) => `<option value="${status}" ${store.value.licenseStatus === status ? 'selected' : ''}>${escapeHtml({ pending: '未激活', active: '启用', disabled: '已禁用', expired: '已到期' }[status])}</option>`).join('')}
        </select>
      </div>
      <form class="inline-actions" id="license-search-form">
        <label class="field-label" for="license-search">精确卡密</label>
        <input class="input mono" id="license-search" name="key" value="${escapeHtml(store.value.licenseSearch)}" placeholder="KMXT-...">
        <button class="icon-button" type="submit" aria-label="查询卡密" title="查询">${icon('search')}</button>
      </form>
    </div>
    <div class="table-frame">
      ${rows ? `<div class="table-scroll"><table><thead><tr><th>卡密</th><th>状态</th><th>有效期</th><th>设备上限</th><th>到期时间</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div>` : emptyState('key-round', '暂无卡密', '当前筛选条件下没有卡密。')}
      ${pagination(data, 'license-page')}
    </div>`;
}

function formatPrice(cents) {
  return cents === 0 ? '人工确认' : `¥ ${(cents / 100).toFixed(2)}`;
}

async function renderProducts() {
  const merchant = store.merchant;
  const application = store.application;
  const appSelector = `<select class="select" id="product-app-context" aria-label="当前程序">
    ${store.value.applications.length ? store.value.applications.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === store.value.selectedAppId ? 'selected' : ''}>${escapeHtml(item.name)} · ${escapeHtml(item.code)}</option>`).join('') : '<option value="">暂无程序</option>'}
  </select>`;
  if (!merchant || !application) {
    return `${pageHeader('商品', '用户购买套餐')}${emptyState('shopping-bag', '暂无程序', '请先创建或选择程序。')}`;
  }
  const products = await api.get(`/api/v1/apps/${encodeURIComponent(application.id)}/products`);
  store.patch({ products });
  const rows = products.map((product) => `<tr>
    <td><span class="cell-primary">${escapeHtml(product.name)}</span><span class="cell-secondary">${escapeHtml(product.description || '-')}</span></td>
    <td>${escapeHtml(formatPrice(product.priceCents))}</td>
    <td>${product.durationDays} 天</td>
    <td>${deviceLimitText(product.maxDevices)}</td>
    <td>${statusBadge(product.status)}</td>
    <td><div class="inline-actions">
      ${isOwner() ? `<button class="icon-button" type="button" data-action="edit-product" data-id="${escapeHtml(product.id)}" aria-label="编辑商品" title="编辑">${icon('pencil')}</button>
      <button class="icon-button" type="button" data-action="toggle-product" data-id="${escapeHtml(product.id)}" data-status="${escapeHtml(product.status)}" aria-label="${product.status === 'active' ? '禁用' : '启用'}商品" title="${product.status === 'active' ? '禁用' : '启用'}">${icon(product.status === 'active' ? 'ban' : 'circle-check')}</button>` : ''}
    </div></td>
  </tr>`).join('');
  const actions = `<a class="button secondary" href="/store/${encodeURIComponent(merchant.code)}" target="_blank" rel="noopener">${icon('external-link')}打开店铺</a>
    ${isOwner() ? `<button class="button" type="button" data-action="create-product">${icon('plus')}新建商品</button>` : ''}`;
  return `${pageHeader('商品', application.name, actions)}
    <div class="toolbar section-header"><div class="inline-actions">${appSelector}</div></div>
    <div class="table-frame">
      ${rows ? `<div class="table-scroll"><table><thead><tr><th>商品</th><th>标价</th><th>授权时长</th><th>设备上限</th><th>状态</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div>` : emptyState('shopping-bag', '暂无商品', '当前程序还没有购买套餐。', isOwner() ? `<button class="button" type="button" data-action="create-product">${icon('plus')}新建商品</button>` : '')}
    </div>`;
}

async function renderOrders() {
  const merchant = store.merchant;
  if (!merchant) {
    return `${pageHeader('订单', '人工审核与发卡')}${emptyState('receipt-text', '未选择商户', '请先创建或选择商户。')}`;
  }
  const query = new URLSearchParams({ page: String(store.value.orderPage), limit: '20' });
  if (store.value.orderStatus) query.set('status', store.value.orderStatus);
  const data = await api.get(`/api/v1/merchants/${encodeURIComponent(merchant.id)}/orders?${query}`);
  store.patch({ orders: data.items });
  const rows = data.items.map((order) => `<tr>
    <td><span class="cell-primary mono">${escapeHtml(order.orderNo)}</span><span class="cell-secondary">${formatDate(order.createdAt)}</span></td>
    <td><span class="cell-primary">${escapeHtml(order.product.name)}</span><span class="cell-secondary">${escapeHtml(order.product.applicationName)}</span></td>
    <td><span class="cell-primary">${escapeHtml(order.customerName || '未填写')}</span><span class="cell-secondary">${escapeHtml(order.contact)}</span></td>
    <td>${statusBadge(order.status, { pending: '待处理', fulfilled: '已发卡', rejected: '已拒绝' }[order.status])}</td>
    <td>${order.licenseKey ? `<button class="icon-button" type="button" data-action="copy-order-license" data-value="${escapeHtml(order.licenseKey)}" aria-label="复制卡密" title="复制卡密">${icon('copy')}</button>` : '-'}</td>
    <td><div class="inline-actions">
      ${order.status === 'pending' ? `<button class="button small" type="button" data-action="fulfill-order" data-id="${escapeHtml(order.id)}">${icon('package-check')}发卡</button><button class="button secondary small" type="button" data-action="reject-order" data-id="${escapeHtml(order.id)}">拒绝</button>` : '-'}
    </div></td>
  </tr>`).join('');
  return `${pageHeader('订单', merchant.name)}
    <div class="toolbar section-header">
      <select class="select" id="order-status-filter" aria-label="订单状态">
        <option value="">全部状态</option>
        ${['pending', 'fulfilled', 'rejected'].map((status) => `<option value="${status}" ${store.value.orderStatus === status ? 'selected' : ''}>${escapeHtml({ pending: '待处理', fulfilled: '已发卡', rejected: '已拒绝' }[status])}</option>`).join('')}
      </select>
    </div>
    <div class="table-frame">
      ${rows ? `<div class="table-scroll"><table><thead><tr><th>订单</th><th>商品</th><th>客户</th><th>状态</th><th>卡密</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div>` : emptyState('receipt-text', '暂无订单', '当前筛选条件下没有订单。')}
      ${pagination(data, 'order-page')}
    </div>`;
}

async function renderUsers() {
  const merchant = store.merchant;
  if (!merchant) {
    return `${pageHeader('账号', '商户账号与角色')}${emptyState('users', '未选择商户', '请先创建或选择商户。')}`;
  }
  const users = await api.get(`/api/v1/merchants/${encodeURIComponent(merchant.id)}/users`);
  const rows = users.map((user) => `<tr>
    <td><span class="cell-primary">${escapeHtml(user.displayName)}</span><span class="cell-secondary mono">${escapeHtml(user.id.slice(0, 8))}</span></td>
    <td>${escapeHtml(user.username)}</td>
    <td>${escapeHtml(roleLabel(user.role))}</td>
    <td>${statusBadge(user.status)}</td>
    <td>${formatDate(user.lastLoginAt)}</td>
    <td>${formatDate(user.createdAt)}</td>
    <td>${user.id === store.value.user.id ? '<span class="cell-secondary">当前账号</span>' : `<button class="icon-button" type="button" data-action="reset-user-password" data-id="${escapeHtml(user.id)}" data-username="${escapeHtml(user.username)}" aria-label="重置 ${escapeHtml(user.username)} 的密码" title="重置密码">${icon('key-round')}</button>`}</td>
  </tr>`).join('');
  return `${pageHeader('账号', merchant.name, `<button class="button" type="button" data-action="create-user">${icon('plus')}新建账号</button>`)}
    <div class="table-frame"><div class="table-scroll"><table><thead><tr><th>账号</th><th>用户名</th><th>角色</th><th>状态</th><th>最后登录</th><th>创建时间</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
}

async function renderLogs() {
  const merchant = store.merchant;
  const application = store.application;
  const canAudit = isOwner();
  if (!canAudit && store.value.logMode === 'audit') {
    store.patch({ logMode: 'verification' });
  }
  const mode = store.value.logMode;
  let data = { items: [], total: 0, page: store.value.logPage, limit: 20 };
  if (mode === 'audit' && merchant) {
    data = await api.get(`/api/v1/merchants/${encodeURIComponent(merchant.id)}/audit-logs?page=${store.value.logPage}&limit=20`);
  } else if (mode === 'verification' && application) {
    data = await api.get(`/api/v1/apps/${encodeURIComponent(application.id)}/verification-logs?page=${store.value.logPage}&limit=20`);
  }
  const controls = `<div class="segmented" role="tablist" aria-label="日志类型">
    ${canAudit ? `<button class="segment ${mode === 'audit' ? 'active' : ''}" type="button" data-action="log-mode" data-mode="audit" role="tab" aria-selected="${mode === 'audit'}">管理审计</button>` : ''}
    <button class="segment ${mode === 'verification' ? 'active' : ''}" type="button" data-action="log-mode" data-mode="verification" role="tab" aria-selected="${mode === 'verification'}">程序验证</button>
  </div>`;
  const rows = data.items.map((entry) => mode === 'audit'
    ? `<tr><td class="cell-primary">${escapeHtml(entry.action)}</td><td>${escapeHtml(entry.actorUsername)}</td><td>${escapeHtml(entry.resourceType)}</td><td class="mono">${escapeHtml(entry.resourceId?.slice(0, 8) || '-')}</td><td>${formatDate(entry.createdAt)}</td></tr>`
    : `<tr><td class="cell-primary">${escapeHtml(entry.event === 'activate' ? '激活' : '心跳')}</td><td class="mono">${escapeHtml(entry.licenseId.slice(0, 8))}</td><td class="mono">${escapeHtml(entry.bindingId.slice(0, 8))}</td><td>${escapeHtml(entry.clientVersion || '-')}</td><td>${formatDate(entry.createdAt)}</td></tr>`).join('');
  const missingContext = mode === 'audit' ? !merchant : !application;
  return `${pageHeader('日志', mode === 'audit' ? (merchant?.name || '管理审计') : (application?.name || '程序验证'), controls)}
    <div class="table-frame">
      ${rows ? `<div class="table-scroll"><table><thead><tr>${mode === 'audit' ? '<th>操作</th><th>执行账号</th><th>资源</th><th>资源 ID</th><th>时间</th>' : '<th>事件</th><th>卡密 ID</th><th>绑定 ID</th><th>版本</th><th>时间</th>'}</tr></thead><tbody>${rows}</tbody></table></div>` : emptyState('scroll-text', '暂无日志', missingContext ? '请先选择对应的商户或程序。' : '当前范围内没有日志。')}
      ${pagination(data, 'log-page')}
    </div>`;
}

async function reloadContext(merchantId) {
  const applications = merchantId
    ? await api.get(`/api/v1/merchants/${encodeURIComponent(merchantId)}/apps`)
    : [];
  const selectedAppId = applications.some((item) => item.id === store.value.selectedAppId)
    ? store.value.selectedAppId
    : applications[0]?.id || null;
  store.patch({
    selectedMerchantId: merchantId,
    applications,
    selectedAppId,
    licensePage: 1,
    orderPage: 1,
    logPage: 1,
    products: [],
    orders: [],
  });
}

function openCreateMerchant() {
  openFormDialog({
    title: '新建商户',
    submitLabel: '创建商户',
    content: `<div class="form-stack">
      <div class="field"><label for="merchant-name">商户名称</label><input class="input" id="merchant-name" name="name" minlength="2" maxlength="100" required autofocus></div>
      <div class="field"><label for="merchant-code">商户代码</label><input class="input mono" id="merchant-code" name="code" minlength="2" maxlength="32" pattern="[A-Za-z0-9_-]+" required></div>
    </div>`,
    onSubmit: async (form) => {
      const merchant = await api.post('/api/v1/platform/merchants', {
        name: form.get('name'),
        code: String(form.get('code')).toUpperCase(),
      });
      store.patch({ merchants: [...store.value.merchants, merchant] });
      await reloadContext(merchant.id);
      showToast('商户已创建。');
      renderShell();
      await renderCurrentView();
    },
  });
}

function openCreateUser() {
  const merchant = store.merchant;
  if (!merchant) return;
  openFormDialog({
    title: '新建商户账号',
    submitLabel: '创建账号',
    content: `<div class="form-grid">
      <div class="field full"><label for="user-display-name">显示名称</label><input class="input" id="user-display-name" name="displayName" maxlength="80" required autofocus></div>
      <div class="field"><label for="user-username">用户名</label><input class="input" id="user-username" name="username" minlength="3" maxlength="64" pattern="[A-Za-z0-9_.-]+" autocomplete="off" required></div>
      <div class="field"><label for="user-role">角色</label><select class="select" id="user-role" name="role"><option value="operator">操作员</option><option value="merchant_admin">商户管理员</option></select></div>
      <div class="field full"><label for="user-password">初始密码</label><input class="input" id="user-password" name="password" type="password" minlength="10" maxlength="128" autocomplete="new-password" required></div>
    </div>`,
    onSubmit: async (form) => {
      await api.post(`/api/v1/merchants/${encodeURIComponent(merchant.id)}/users`, {
        displayName: form.get('displayName'),
        username: form.get('username'),
        password: form.get('password'),
        role: form.get('role'),
      });
      showToast('账号已创建。');
      await renderCurrentView();
    },
  });
}

function openChangePassword() {
  openFormDialog({
    title: '修改密码',
    submitLabel: '修改并退出',
    content: `<div class="form-stack">
      <div class="field"><label for="current-password">当前密码</label><input class="input" id="current-password" name="currentPassword" type="password" minlength="10" maxlength="128" autocomplete="current-password" required autofocus></div>
      <div class="field"><label for="new-password">新密码</label><input class="input" id="new-password" name="newPassword" type="password" minlength="10" maxlength="128" autocomplete="new-password" required></div>
      <div class="field"><label for="confirm-new-password">确认新密码</label><input class="input" id="confirm-new-password" name="confirmPassword" type="password" minlength="10" maxlength="128" autocomplete="new-password" required></div>
    </div>`,
    onSubmit: async (form) => {
      const newPassword = form.get('newPassword');
      if (newPassword !== form.get('confirmPassword')) {
        throw new Error('两次输入的新密码不一致。');
      }
      try {
        await api.post('/api/v1/auth/password', {
          currentPassword: form.get('currentPassword'),
          newPassword,
        });
      } catch (error) {
        throw new Error(friendlyError(error));
      }
      api.clearToken();
      store.reset();
      history.replaceState(null, '', `${location.pathname}`);
      renderLogin();
      showToast('密码已修改，请使用新密码重新登录。');
    },
  });
}

function openResetUserPassword(userId, username) {
  openFormDialog({
    title: `重置 ${username} 的密码`,
    submitLabel: '确认重置',
    content: `<div class="form-stack">
      <div class="field"><label for="reset-password">新密码</label><input class="input" id="reset-password" name="newPassword" type="password" minlength="10" maxlength="128" autocomplete="new-password" required autofocus></div>
      <div class="field"><label for="confirm-reset-password">确认新密码</label><input class="input" id="confirm-reset-password" name="confirmPassword" type="password" minlength="10" maxlength="128" autocomplete="new-password" required></div>
    </div>`,
    onSubmit: async (form) => {
      const newPassword = form.get('newPassword');
      if (newPassword !== form.get('confirmPassword')) {
        throw new Error('两次输入的新密码不一致。');
      }
      try {
        await api.post(`/api/v1/users/${encodeURIComponent(userId)}/password/reset`, { newPassword });
      } catch (error) {
        throw new Error(friendlyError(error));
      }
      showToast(`已重置 ${username} 的密码，该账号需要重新登录。`);
    },
  });
}

function openCreateApplication() {
  const merchant = store.merchant;
  if (!merchant || !isOwner()) return;
  openFormDialog({
    title: '新建程序',
    submitLabel: '创建程序',
    wide: true,
    content: `<div class="form-grid">
      <div class="field"><label for="app-name">程序名称</label><input class="input" id="app-name" name="name" minlength="2" maxlength="100" required autofocus></div>
      <div class="field"><label for="app-code">程序代码</label><input class="input mono" id="app-code" name="code" minlength="2" maxlength="32" pattern="[A-Za-z0-9_-]+" required></div>
      <div class="field full"><label for="app-description">备注</label><textarea class="textarea" id="app-description" name="description" maxlength="500"></textarea></div>
      <div class="field"><label for="app-days">默认有效天数</label><input class="input" id="app-days" name="defaultDurationDays" type="number" min="1" max="3650" value="30" required></div>
      <div class="field"><label for="app-devices">默认设备数（0 表示无限制）</label><input class="input" id="app-devices" name="defaultMaxDevices" type="number" min="0" max="20" value="1" required></div>
      <div class="field"><label for="app-heartbeat">心跳间隔（秒）</label><input class="input" id="app-heartbeat" name="heartbeatSeconds" type="number" min="30" max="86400" value="300" required></div>
      <div class="field"><label for="app-offline">离线容忍（秒）</label><input class="input" id="app-offline" name="offlineGraceSeconds" type="number" min="60" max="604800" value="900" required></div>
    </div>`,
    onSubmit: async (form) => {
      const application = await api.post(`/api/v1/merchants/${encodeURIComponent(merchant.id)}/apps`, {
        name: form.get('name'),
        code: String(form.get('code')).toUpperCase(),
        description: form.get('description') || undefined,
        settings: {
          defaultDurationDays: Number(form.get('defaultDurationDays')),
          defaultMaxDevices: Number(form.get('defaultMaxDevices')),
          heartbeatSeconds: Number(form.get('heartbeatSeconds')),
          offlineGraceSeconds: Number(form.get('offlineGraceSeconds')),
        },
      });
      store.patch({
        applications: [...store.value.applications, application],
        selectedAppId: application.id,
      });
      showToast('程序已创建。');
      renderShell();
      await renderCurrentView();
    },
  });
}

function openProductForm(product = null) {
  const application = store.application;
  if (!application || !isOwner()) return;
  openFormDialog({
    title: product ? '编辑商品' : '新建商品',
    submitLabel: product ? '保存商品' : '创建商品',
    content: `<div class="form-grid">
      <div class="field full"><label for="product-name">商品名称</label><input class="input" id="product-name" name="name" minlength="2" maxlength="100" value="${escapeHtml(product?.name || '')}" required autofocus></div>
      <div class="field full"><label for="product-description">商品说明</label><textarea class="textarea" id="product-description" name="description" maxlength="500">${escapeHtml(product?.description || '')}</textarea></div>
      <div class="field"><label for="product-price">标价（元）</label><input class="input" id="product-price" name="price" type="number" min="0" max="999999.99" step="0.01" value="${product ? (product.priceCents / 100).toFixed(2) : '0.00'}" required></div>
      <div class="field"><label for="product-sort">排序</label><input class="input" id="product-sort" name="sortOrder" type="number" min="0" max="10000" value="${product?.sortOrder ?? 0}" required></div>
      <div class="field"><label for="product-days">授权天数</label><input class="input" id="product-days" name="durationDays" type="number" min="1" max="3650" value="${product?.durationDays ?? application.settings.defaultDurationDays}" required></div>
      <div class="field"><label for="product-devices">设备上限（0 表示无限制）</label><input class="input" id="product-devices" name="maxDevices" type="number" min="0" max="20" value="${product?.maxDevices ?? application.settings.defaultMaxDevices}" required></div>
    </div>`,
    onSubmit: async (form) => {
      const price = Number(form.get('price'));
      const body = {
        name: form.get('name'),
        description: form.get('description') || '',
        priceCents: Math.round(price * 100),
        durationDays: Number(form.get('durationDays')),
        maxDevices: Number(form.get('maxDevices')),
        sortOrder: Number(form.get('sortOrder')),
      };
      if (product) {
        await api.patch(`/api/v1/products/${encodeURIComponent(product.id)}`, body);
      } else {
        await api.post(`/api/v1/apps/${encodeURIComponent(application.id)}/products`, body);
      }
      showToast(product ? '商品已更新。' : '商品已创建。');
      await renderCurrentView();
    },
  });
}

function openRejectOrder(orderId) {
  openFormDialog({
    title: '拒绝订单',
    submitLabel: '确认拒绝',
    content: `<div class="field"><label for="reject-reason">拒绝原因</label><textarea class="textarea" id="reject-reason" name="reason" minlength="2" maxlength="300" required autofocus></textarea></div>`,
    onSubmit: async (form) => {
      await api.post(`/api/v1/orders/${encodeURIComponent(orderId)}/reject`, {
        reason: form.get('reason'),
      });
      showToast('订单已拒绝。');
      await renderCurrentView();
    },
  });
}

function openGenerateLicenses() {
  const application = store.application;
  if (!application) return;
  openFormDialog({
    title: '生成卡密',
    submitLabel: '生成',
    content: `<div class="form-grid">
      <div class="field full"><label for="batch-name">批次名称</label><input class="input" id="batch-name" name="batchName" maxlength="100" required autofocus></div>
      <div class="field"><label for="batch-count">数量</label><input class="input" id="batch-count" name="count" type="number" min="1" max="1000" value="10" required></div>
      <div class="field"><label for="batch-devices">设备上限（0 表示无限制）</label><input class="input" id="batch-devices" name="maxDevices" type="number" min="0" max="20" value="${application.settings.defaultMaxDevices}" required></div>
      <div class="field full"><label for="license-mode">有效期方式</label><select class="select" id="license-mode" name="mode"><option value="duration">首次激活计时</option><option value="fixed">固定到期时间</option></select></div>
      <div class="field full" data-duration-field><label for="duration-days">有效天数</label><input class="input" id="duration-days" name="durationDays" type="number" min="1" max="3650" value="${application.settings.defaultDurationDays}" required></div>
      <div class="field full" data-fixed-field hidden><label for="fixed-expires">到期时间</label><input class="input" id="fixed-expires" name="fixedExpiresAt" type="datetime-local"></div>
    </div>`,
    onOpen: (dialog) => {
      const mode = dialog.querySelector('#license-mode');
      const durationField = dialog.querySelector('[data-duration-field]');
      const fixedField = dialog.querySelector('[data-fixed-field]');
      const durationInput = dialog.querySelector('#duration-days');
      const fixedInput = dialog.querySelector('#fixed-expires');
      mode.addEventListener('change', () => {
        const fixed = mode.value === 'fixed';
        durationField.hidden = fixed;
        fixedField.hidden = !fixed;
        durationInput.required = !fixed;
        fixedInput.required = fixed;
      });
    },
    onSubmit: async (form) => {
      const body = {
        batchName: form.get('batchName'),
        count: Number(form.get('count')),
        maxDevices: Number(form.get('maxDevices')),
      };
      if (form.get('mode') === 'fixed') {
        body.fixedExpiresAt = new Date(form.get('fixedExpiresAt')).toISOString();
      } else {
        body.durationDays = Number(form.get('durationDays'));
      }
      const result = await api.post(`/api/v1/apps/${encodeURIComponent(application.id)}/license-batches`, body);
      showToast(`已生成 ${result.licenses.length} 个卡密。`);
      await renderCurrentView();
      window.setTimeout(() => showGeneratedKeys(result), 0);
    },
  });
}

function showGeneratedKeys(result) {
  const keys = result.licenses.map((license) => license.key).join('\n');
  const dialog = openContentDialog({
    title: `卡密批次 · ${result.licenses.length} 个`,
    wide: true,
    content: `<div class="form-stack">
      <div class="field"><label for="generated-keys">卡密明文（仅本次显示）</label><textarea class="generated-keys" id="generated-keys" readonly>${escapeHtml(keys)}</textarea></div>
    </div>`,
    footer: `<button class="button secondary" type="button" data-generated-action="copy">${icon('copy')}复制全部</button><button class="button" type="button" data-generated-action="download">${icon('download')}导出文本</button>`,
  });
  dialog.addEventListener('click', async (event) => {
    const action = event.target.closest('[data-generated-action]')?.dataset.generatedAction;
    if (action === 'copy') {
      try {
        await navigator.clipboard.writeText(keys);
        showToast('卡密已复制。');
      } catch {
        dialog.querySelector('#generated-keys').select();
        document.execCommand('copy');
        showToast('卡密已复制。');
      }
    }
    if (action === 'download') {
      downloadText(`kmxt-licenses-${result.batch.id}.txt`, `${keys}\n`);
    }
  });
}

async function showDevices(licenseId) {
  setBusy(true);
  try {
    const devices = await api.get(`/api/v1/licenses/${encodeURIComponent(licenseId)}/devices`);
    const rows = devices.map((device) => `<tr>
      <td><span class="cell-primary">${escapeHtml(device.deviceLabel || '未命名设备')}</span><span class="cell-secondary mono">${escapeHtml(device.id.slice(0, 8))}</span></td>
      <td>${statusBadge(device.status)}</td><td>${formatDate(device.boundAt)}</td><td>${formatDate(device.lastVerifiedAt)}</td>
      <td>${device.status === 'active' ? `<button class="button danger small" type="button" data-action="unbind-device" data-id="${escapeHtml(device.id)}" data-license-id="${escapeHtml(licenseId)}">${icon('unlink')}解绑</button>` : '-'}</td>
    </tr>`).join('');
    openContentDialog({
      title: '设备绑定',
      wide: true,
      content: rows ? `<div class="table-frame"><div class="table-scroll"><table><thead><tr><th>设备</th><th>状态</th><th>绑定时间</th><th>最后验证</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div></div>` : emptyState('monitor-smartphone', '暂无设备', '该卡密尚未绑定设备。'),
    });
  } catch (error) {
    showToast(friendlyError(error), 'error');
  } finally {
    setBusy(false);
  }
}

async function performAction(action) {
  try {
    setBusy(true);
    await action();
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 401)) {
      showToast(friendlyError(error), 'error');
    }
  } finally {
    setBusy(false);
  }
}

document.addEventListener('click', async (event) => {
  const viewButton = event.target.closest('[data-view]');
  if (viewButton) {
    const view = viewButton.dataset.view;
    if (availableViews().some((item) => item.id === view)) {
      location.hash = view;
    }
    return;
  }
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const { action, id, status, mode, licenseId, username } = button.dataset;

  if (action === 'toggle-sidebar') {
    store.patch({ sidebarOpen: !store.value.sidebarOpen });
    renderShell();
    await renderCurrentView();
  } else if (action === 'close-sidebar') {
    store.patch({ sidebarOpen: false });
    renderShell();
    await renderCurrentView();
  } else if (action === 'refresh') {
    await renderCurrentView();
  } else if (action === 'logout') {
    await performAction(async () => {
      await api.post('/api/v1/auth/logout', {});
      api.clearToken();
      store.reset();
      history.replaceState(null, '', `${location.pathname}`);
      renderLogin();
    });
  } else if (action === 'change-password') {
    openChangePassword();
  } else if (action === 'reset-user-password') {
    openResetUserPassword(id, username);
  } else if (action === 'create-merchant') {
    openCreateMerchant();
  } else if (action === 'create-user') {
    openCreateUser();
  } else if (action === 'create-app') {
    openCreateApplication();
  } else if (action === 'create-product') {
    openProductForm();
  } else if (action === 'edit-product') {
    const product = store.value.products.find((item) => item.id === id);
    if (product) openProductForm(product);
  } else if (action === 'generate-licenses') {
    openGenerateLicenses();
  } else if (action === 'select-merchant') {
    await performAction(async () => {
      await reloadContext(id);
      store.patch({ view: 'applications' });
      location.hash = 'applications';
      renderShell();
      await renderCurrentView();
    });
  } else if (action === 'select-app') {
    store.patch({ selectedAppId: id, licensePage: 1, view: 'licenses' });
    location.hash = 'licenses';
    renderShell();
    await renderCurrentView();
  } else if (action === 'download-client-config') {
    await performAction(async () => {
      const result = await api.get(`/api/v1/apps/${encodeURIComponent(id)}/client-config`);
      const safeCode = String(button.dataset.code || 'app').toLowerCase().replace(/[^a-z0-9_-]/g, '-');
      if (button.dataset.format === 'hpp') {
        downloadText(`kmxt-${safeCode}.hpp`, result.cppHeader);
      } else {
        downloadText(`kmxt-${safeCode}.json`, `${JSON.stringify(result.config, null, 2)}\n`, 'application/json;charset=utf-8');
      }
      showToast('Android 配置已生成。');
    });
  } else if (action === 'toggle-merchant') {
    const nextStatus = status === 'active' ? 'disabled' : 'active';
    const confirmed = nextStatus === 'active' || await confirmAction({ title: '禁用商户', message: '商户的管理会话和程序验证会话将立即失效。', confirmLabel: '确认禁用' });
    if (confirmed) await performAction(async () => {
      const updated = await api.patch(`/api/v1/platform/merchants/${encodeURIComponent(id)}/status`, { status: nextStatus });
      store.patch({ merchants: store.value.merchants.map((item) => item.id === id ? updated : item) });
      showToast(nextStatus === 'active' ? '商户已启用。' : '商户已禁用。');
      await renderCurrentView();
    });
  } else if (action === 'toggle-app') {
    const nextStatus = status === 'active' ? 'disabled' : 'active';
    const confirmed = nextStatus === 'active' || await confirmAction({ title: '禁用程序', message: '程序的全部验证会话将立即失效。', confirmLabel: '确认禁用' });
    if (confirmed) await performAction(async () => {
      const updated = await api.patch(`/api/v1/apps/${encodeURIComponent(id)}/status`, { status: nextStatus });
      store.patch({ applications: store.value.applications.map((item) => item.id === id ? updated : item) });
      showToast(nextStatus === 'active' ? '程序已启用。' : '程序已禁用。');
      renderShell();
      await renderCurrentView();
    });
  } else if (action === 'toggle-license') {
    const nextStatus = status === 'disabled' ? 'active' : 'disabled';
    const confirmed = nextStatus === 'active' || await confirmAction({ title: '禁用卡密', message: '卡密的全部验证会话将立即失效。', confirmLabel: '确认禁用' });
    if (confirmed) await performAction(async () => {
      await api.patch(`/api/v1/licenses/${encodeURIComponent(id)}/status`, { status: nextStatus });
      showToast(nextStatus === 'active' ? '卡密已启用。' : '卡密已禁用。');
      await renderCurrentView();
    });
  } else if (action === 'toggle-product') {
    const nextStatus = status === 'active' ? 'disabled' : 'active';
    const confirmed = nextStatus === 'active' || await confirmAction({ title: '禁用商品', message: '店铺将立即停止展示该商品。', confirmLabel: '确认禁用' });
    if (confirmed) await performAction(async () => {
      await api.patch(`/api/v1/products/${encodeURIComponent(id)}/status`, { status: nextStatus });
      showToast(nextStatus === 'active' ? '商品已启用。' : '商品已禁用。');
      await renderCurrentView();
    });
  } else if (action === 'fulfill-order') {
    const confirmed = await confirmAction({ title: '审核并发卡', message: '系统将生成一张卡密并交付给该订单。', confirmLabel: '确认发卡' });
    if (confirmed) await performAction(async () => {
      await api.post(`/api/v1/orders/${encodeURIComponent(id)}/fulfill`, {});
      showToast('卡密已发放。');
      await renderCurrentView();
    });
  } else if (action === 'reject-order') {
    openRejectOrder(id);
  } else if (action === 'copy-order-license') {
    await performAction(async () => {
      await navigator.clipboard.writeText(button.dataset.value);
      showToast('卡密已复制。');
    });
  } else if (action === 'show-devices') {
    await showDevices(id);
  } else if (action === 'unbind-device') {
    const confirmed = await confirmAction({ title: '解绑设备', message: '当前设备会话将立即失效，之后可重新绑定设备。', confirmLabel: '确认解绑' });
    if (confirmed) await performAction(async () => {
      await api.post(`/api/v1/device-bindings/${encodeURIComponent(id)}/unbind`, {});
      button.closest('dialog')?.close();
      showToast('设备已解绑。');
      await showDevices(licenseId);
    });
  } else if (action === 'license-page-previous' || action === 'license-page-next') {
    store.patch({ licensePage: Math.max(1, store.value.licensePage + (action.endsWith('next') ? 1 : -1)) });
    await renderCurrentView();
  } else if (action === 'order-page-previous' || action === 'order-page-next') {
    store.patch({ orderPage: Math.max(1, store.value.orderPage + (action.endsWith('next') ? 1 : -1)) });
    await renderCurrentView();
  } else if (action === 'log-page-previous' || action === 'log-page-next') {
    store.patch({ logPage: Math.max(1, store.value.logPage + (action.endsWith('next') ? 1 : -1)) });
    await renderCurrentView();
  } else if (action === 'log-mode') {
    store.patch({ logMode: mode, logPage: 1 });
    await renderCurrentView();
  }
});

document.addEventListener('change', async (event) => {
  if (event.target.id === 'merchant-context') {
    await performAction(async () => {
      await reloadContext(event.target.value || null);
      renderShell();
      await renderCurrentView();
    });
  } else if (event.target.id === 'license-app-context') {
    store.patch({ selectedAppId: event.target.value || null, licensePage: 1 });
    await renderCurrentView();
  } else if (event.target.id === 'license-status-filter') {
    store.patch({ licenseStatus: event.target.value, licensePage: 1 });
    await renderCurrentView();
  } else if (event.target.id === 'product-app-context') {
    store.patch({ selectedAppId: event.target.value || null, products: [] });
    await renderCurrentView();
  } else if (event.target.id === 'order-status-filter') {
    store.patch({ orderStatus: event.target.value, orderPage: 1 });
    await renderCurrentView();
  }
});

document.addEventListener('submit', async (event) => {
  if (event.target.id === 'license-search-form') {
    event.preventDefault();
    const form = new FormData(event.target);
    store.patch({ licenseSearch: String(form.get('key') || '').trim(), licensePage: 1 });
    await renderCurrentView();
  }
});

window.addEventListener('hashchange', async () => {
  if (!store.value.user) return;
  const requested = location.hash.replace(/^#\/?/, '') || 'overview';
  const view = availableViews().some((item) => item.id === requested) ? requested : 'overview';
  store.patch({ view, sidebarOpen: false });
  renderShell();
  await renderCurrentView();
});

window.addEventListener('kmxt:unauthorized', () => {
  store.reset();
  renderLogin();
});

async function bootstrap() {
  if (!api.hasToken()) {
    renderLogin();
    return;
  }
  try {
    await initializeSession();
  } catch (error) {
    api.clearToken();
    store.reset();
    renderLogin();
    if (error.status !== 401) {
      showToast(friendlyError(error), 'error');
    }
  }
}

bootstrap();
