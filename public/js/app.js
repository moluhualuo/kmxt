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
import { renderOverviewView } from './views/overview.js';
import { renderMerchantsView } from './views/merchants.js';
import { renderApplicationsView } from './views/applications.js';
import { renderLicensesView } from './views/licenses.js';
import { renderProductsView } from './views/products.js';
import { renderOrdersView } from './views/orders.js';
import { renderUsersView } from './views/users.js';
import { renderLogsView } from './views/logs.js';

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
    LICENSE_KEY_UNAVAILABLE: '该历史卡密没有可恢复的加密副本，无法显示完整卡密。',
    LICENSE_HAS_ORDER: '该卡密关联已发卡订单，为保留交付记录不能删除。',
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
      case 'merchants': html = await renderMerchantsView(); break;
      case 'applications': html = await renderApplicationsView(); break;
      case 'licenses': html = await renderLicensesView(); break;
      case 'products': html = await renderProductsView(); break;
      case 'orders': html = await renderOrdersView(); break;
      case 'users': html = await renderUsersView(); break;
      case 'logs': html = await renderLogsView(); break;
      default: html = await renderOverviewView({
        api, store, pageHeader, icon, emptyState, escapeHtml, formatDate, isPlatformAdmin,
      });
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

function openEditMerchant(merchant) {
  if (!isPlatformAdmin() || !merchant) return;
  openFormDialog({
    title: '编辑商户资料',
    submitLabel: '保存资料',
    content: `<div class="form-stack">
      <div class="field"><label for="merchant-edit-name">商户名称</label><input class="input" id="merchant-edit-name" name="name" minlength="2" maxlength="100" value="${escapeHtml(merchant.name)}" required autofocus></div>
      <div class="field"><label for="merchant-edit-code">商户代码</label><input class="input mono" id="merchant-edit-code" value="${escapeHtml(merchant.code)}" readonly aria-readonly="true"><span class="field-hint">商户代码是唯一标识，创建后不能修改。</span></div>
    </div>`,
    onSubmit: async (form) => {
      const updated = await api.patch(`/api/v1/platform/merchants/${encodeURIComponent(merchant.id)}`, { name: form.get('name') });
      store.patch({ merchants: store.value.merchants.map((item) => item.id === updated.id ? updated : item) });
      showToast('商户资料已保存。');
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

function openEditApplication(application) {
  if (!application || !isOwner()) return;
  const settings = application.settings;
  openFormDialog({
    title: '编辑程序设置',
    submitLabel: '保存设置',
    wide: true,
    content: `<div class="form-grid">
      <div class="field"><label for="app-edit-name">程序名称</label><input class="input" id="app-edit-name" name="name" minlength="2" maxlength="100" value="${escapeHtml(application.name)}" required autofocus></div>
      <div class="field"><label for="app-edit-code">程序代码</label><input class="input mono" id="app-edit-code" value="${escapeHtml(application.code)}" readonly aria-readonly="true"><span class="field-hint">程序代码和签名密钥不会在此页面修改。</span></div>
      <div class="field full"><label for="app-edit-description">说明</label><textarea class="textarea" id="app-edit-description" name="description" maxlength="500">${escapeHtml(application.description || '')}</textarea></div>
      <div class="field"><label for="app-edit-days">默认授权天数</label><input class="input" id="app-edit-days" name="defaultDurationDays" type="number" min="1" max="3650" value="${settings.defaultDurationDays}" required></div>
      <div class="field"><label for="app-edit-devices">默认设备数（0 表示无限制）</label><input class="input" id="app-edit-devices" name="defaultMaxDevices" type="number" min="0" max="20" value="${settings.defaultMaxDevices}" required></div>
      <div class="field"><label for="app-edit-heartbeat">心跳间隔（秒）</label><input class="input" id="app-edit-heartbeat" name="heartbeatSeconds" type="number" min="30" max="86400" value="${settings.heartbeatSeconds}" required></div>
      <div class="field"><label for="app-edit-offline">离线宽限（秒）</label><input class="input" id="app-edit-offline" name="offlineGraceSeconds" type="number" min="60" max="604800" value="${settings.offlineGraceSeconds}" required></div>
    </div>`,
    onSubmit: async (form) => {
      const updated = await api.patch(`/api/v1/apps/${encodeURIComponent(application.id)}`, {
        name: form.get('name'),
        description: form.get('description') || '',
        settings: {
          defaultDurationDays: Number(form.get('defaultDurationDays')),
          defaultMaxDevices: Number(form.get('defaultMaxDevices')),
          heartbeatSeconds: Number(form.get('heartbeatSeconds')),
          offlineGraceSeconds: Number(form.get('offlineGraceSeconds')),
        },
      });
      store.patch({ applications: store.value.applications.map((item) => item.id === updated.id ? updated : item) });
      showToast('程序设置已保存，签名密钥未变更。');
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

async function showLicenseBatches(appId) {
  const data = await api.get(`/api/v1/apps/${encodeURIComponent(appId)}/license-batches?page=1&limit=100`);
  const rows = data.items.map((batch) => `<tr>
    <td><span class="cell-primary">${escapeHtml(batch.name || '未命名批次')}</span><span class="cell-secondary mono">${escapeHtml(batch.id.slice(0, 8))}</span></td>
    <td>${batch.count}</td>
    <td>${batch.durationDays ? `${batch.durationDays} 天` : formatDate(batch.fixedExpiresAt, { dateOnly: true })}</td>
    <td>${deviceLimitText(batch.maxDevices)}</td>
    <td>${escapeHtml(batch.source || 'manual')}</td>
    <td>${formatDate(batch.createdAt)}</td>
  </tr>`).join('');
  openContentDialog({
    title: `卡密批次 · 共 ${data.total} 条`,
    wide: true,
    content: rows
      ? `<div class="table-frame"><div class="table-scroll"><table><thead><tr><th>批次</th><th>数量</th><th>有效期</th><th>设备上限</th><th>来源</th><th>创建时间</th></tr></thead><tbody>${rows}</tbody></table></div></div><p class="field-hint">批次记录不显示卡密明文；授权管理员可在卡密列表中单独查看，且操作会被审计。</p>`
      : emptyState('key-round', '暂无批次', '当前程序尚未生成卡密批次。'),
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

// Author: 花落. License device management UI is provided under the MIT License.
async function showLicenseKey(licenseId) {
  const result = await api.post(`/api/v1/licenses/${encodeURIComponent(licenseId)}/reveal-key`, {});
  const key = result.key;
  const dialog = openContentDialog({
    title: '完整卡密',
    content: `<div class="form-stack">
      <p class="field-hint">此查看操作已写入审计记录，请仅在安全环境中复制和交付。</p>
      <div class="field"><label for="revealed-license-key">卡密明文</label><textarea class="generated-keys" id="revealed-license-key" readonly>${escapeHtml(key)}</textarea></div>
    </div>`,
    footer: `<button class="button" type="button" data-revealed-key-action="copy">${icon('copy')}复制卡密</button>`,
  });
  dialog.addEventListener('click', async (event) => {
    if (event.target.closest('[data-revealed-key-action]')?.dataset.revealedKeyAction !== 'copy') return;
    try {
      await navigator.clipboard.writeText(key);
    } catch {
      dialog.querySelector('#revealed-license-key').select();
      document.execCommand('copy');
    }
    showToast('卡密已复制。');
  });
}

async function showDevices(licenseId) {
  setBusy(true);
  try {
    const devices = await api.get(`/api/v1/licenses/${encodeURIComponent(licenseId)}/devices`);
    const activeDeviceCount = devices.filter((device) => device.status === 'active').length;
    const rows = devices.map((device) => `<tr>
      <td><span class="cell-primary">${escapeHtml(device.deviceLabel || '未命名设备')}</span><span class="cell-secondary mono">${escapeHtml(device.id.slice(0, 8))}</span></td>
      <td>${statusBadge(device.status)}</td><td>${formatDate(device.boundAt)}</td><td>${formatDate(device.lastVerifiedAt)}</td>
      <td>${device.status === 'active' ? `<button class="button danger small" type="button" data-action="unbind-device" data-id="${escapeHtml(device.id)}" data-license-id="${escapeHtml(licenseId)}">${icon('unlink')}解绑</button>` : '-'}</td>
    </tr>`).join('');
    openContentDialog({
      title: '设备绑定',
      wide: true,
      content: rows ? `<div class="table-frame"><div class="table-scroll"><table><thead><tr><th>设备</th><th>状态</th><th>绑定时间</th><th>最后验证</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div></div>` : emptyState('monitor-smartphone', '暂无设备', '该卡密尚未绑定设备。'),
      footer: activeDeviceCount > 0
        ? `<button class="button danger" type="button" data-action="unbind-all-devices" data-id="${escapeHtml(licenseId)}">${icon('unlink')}解绑全部设备</button>`
        : '',
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
  } else if (action === 'toggle-user') {
    const nextStatus = status === 'active' ? 'disabled' : 'active';
    const confirmed = nextStatus === 'active' || await confirmAction({ title: '停用账号', message: '该账号的全部管理会话将立即失效。', confirmLabel: '确认停用' });
    if (confirmed) await performAction(async () => {
      const result = await api.patch(`/api/v1/users/${encodeURIComponent(id)}/status`, { status: nextStatus });
      showToast(nextStatus === 'active' ? '账号已启用。' : `账号已停用，已撤销 ${result.sessionsRevoked} 个会话。`);
      await renderCurrentView();
    });
  } else if (action === 'create-merchant') {
    openCreateMerchant();
  } else if (action === 'edit-merchant') {
    const merchant = store.value.merchants.find((item) => item.id === id);
    if (merchant) openEditMerchant(merchant);
  } else if (action === 'create-user') {
    openCreateUser();
  } else if (action === 'create-app') {
    openCreateApplication();
  } else if (action === 'edit-app') {
    const application = store.value.applications.find((item) => item.id === id);
    if (application) openEditApplication(application);
  } else if (action === 'create-product') {
    openProductForm();
  } else if (action === 'edit-product') {
    const product = store.value.products.find((item) => item.id === id);
    if (product) openProductForm(product);
  } else if (action === 'generate-licenses') {
    openGenerateLicenses();
  } else if (action === 'show-license-batches') {
    await performAction(() => showLicenseBatches(id));
  } else if (action === 'select-merchant') {
    await performAction(async () => {
      await reloadContext(id);
      store.patch({ view: 'applications' });
      location.hash = 'applications';
      renderShell();
      await renderCurrentView();
    });
  } else if (action === 'select-app') {
    store.patch({ selectedAppId: id, licensePage: 1, selectedLicenseIds: [], view: 'licenses' });
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
  } else if (action === 'reveal-license-key') {
    const confirmed = await confirmAction({ title: '查看完整卡密', message: '完整卡密将显示在当前页面，本次查看会写入审计记录。', confirmLabel: '确认查看' });
    if (confirmed) await performAction(() => showLicenseKey(id));
  } else if (action === 'delete-license') {
    const confirmed = await confirmAction({ title: '删除卡密', message: '删除后将撤销该卡密全部会话并清除设备绑定和验证记录，此操作不可恢复。已关联订单的卡密不能删除。', confirmLabel: '确认删除' });
    if (confirmed) await performAction(async () => {
      const result = await api.delete(`/api/v1/licenses/${encodeURIComponent(id)}`);
      store.patch({ selectedLicenseIds: (store.value.selectedLicenseIds || []).filter((licenseId) => licenseId !== id) });
      showToast(`卡密已删除，已清理 ${result.deletedBindings} 条设备绑定。`);
      await renderCurrentView();
    });
  } else if (action === 'bulk-delete-licenses') {
    const licenseIds = [...new Set(store.value.selectedLicenseIds || [])];
    if (!licenseIds.length || !store.application) {
      showToast('请先选择要删除的卡密。', 'error');
      return;
    }
    const confirmed = await confirmAction({ title: '批量删除卡密', message: `将删除已选 ${licenseIds.length} 个卡密，并撤销对应会话、设备绑定和验证记录。已关联订单的卡密会自动跳过并在结果中提示。`, confirmLabel: '确认批量删除' });
    if (confirmed) await performAction(async () => {
      const result = await api.post(`/api/v1/apps/${encodeURIComponent(store.application.id)}/licenses/bulk-delete`, { licenseIds });
      store.patch({ selectedLicenseIds: [] });
      const failedCount = result.failed?.length || 0;
      const message = failedCount
        ? `已删除 ${result.deletedCount} 个，${failedCount} 个未删除。`
        : `已删除 ${result.deletedCount} 个卡密，已清理 ${result.deletedBindings} 条设备绑定。`;
      showToast(message, failedCount ? 'error' : 'success');
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
  } else if (action === 'clear-order-filters') {
    store.patch({ orderNo: '', orderFrom: '', orderTo: '', orderStatus: '', orderPage: 1 });
    await renderCurrentView();
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
  } else if (action === 'unbind-all-devices') {
    const confirmed = await confirmAction({ title: '解绑全部设备', message: '该卡密的全部设备会话将立即失效，所有设备之后均需重新激活。', confirmLabel: '确认全部解绑' });
    if (confirmed) await performAction(async () => {
      const result = await api.post(`/api/v1/licenses/${encodeURIComponent(id)}/unbind-all`, {});
      button.closest('dialog')?.close();
      showToast(`已解绑 ${result.unboundCount} 台设备。`);
      await showDevices(id);
    });
  } else if (action === 'license-page-previous' || action === 'license-page-next') {
    store.patch({ licensePage: Math.max(1, store.value.licensePage + (action.endsWith('next') ? 1 : -1)), selectedLicenseIds: [] });
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
  } else if (action === 'clear-log-filters') {
    store.patch({ auditAction: '', verificationEvent: '', verificationResultCode: '', logFrom: '', logTo: '', logPage: 1 });
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
    store.patch({ selectedAppId: event.target.value || null, licensePage: 1, selectedLicenseIds: [] });
    await renderCurrentView();
  } else if (event.target.id === 'license-status-filter') {
    store.patch({ licenseStatus: event.target.value, licensePage: 1, selectedLicenseIds: [] });
    await renderCurrentView();
  } else if (event.target.id === 'license-limit') {
    const limit = Math.min(100, Math.max(1, Number.parseInt(event.target.value || '20', 10)));
    store.patch({ licenseLimit: [20, 50, 100].includes(limit) ? limit : 20, licensePage: 1, selectedLicenseIds: [] });
    await renderCurrentView();
  } else if (event.target.id === 'license-select-all') {
    const ids = [...document.querySelectorAll('[data-license-select]')].map((input) => input.value);
    store.patch({ selectedLicenseIds: event.target.checked ? ids : [] });
    await renderCurrentView();
  } else if (event.target.matches('[data-license-select]')) {
    const selected = new Set(store.value.selectedLicenseIds || []);
    event.target.checked ? selected.add(event.target.value) : selected.delete(event.target.value);
    store.patch({ selectedLicenseIds: [...selected] });
    const button = document.querySelector('[data-action="bulk-delete-licenses"]');
    if (button) {
      button.disabled = selected.size === 0;
      const label = selected.size > 0 ? `批量删除（${selected.size}）` : '批量删除';
      button.innerHTML = `${icon('trash-2')}${label}`;
    }
    const selectAll = document.querySelector('#license-select-all');
    const boxes = [...document.querySelectorAll('[data-license-select]')];
    if (selectAll && boxes.length) {
      selectAll.checked = boxes.every((input) => input.checked);
      selectAll.indeterminate = boxes.some((input) => input.checked) && !selectAll.checked;
    }
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
    store.patch({ licenseSearch: String(form.get('key') || '').trim(), licensePage: 1, selectedLicenseIds: [] });
    await renderCurrentView();
  } else if (event.target.id === 'order-filter-form') {
    event.preventDefault();
    const form = new FormData(event.target);
    const from = String(form.get('from') || '');
    const to = String(form.get('to') || '');
    if (from && to && Date.parse(from) > Date.parse(to)) {
      showToast('结束时间必须晚于开始时间。', 'error');
      return;
    }
    store.patch({ orderNo: String(form.get('orderNo') || '').trim(), orderFrom: from, orderTo: to, orderPage: 1 });
    await renderCurrentView();
  } else if (event.target.id === 'log-filter-form') {
    event.preventDefault();
    const form = new FormData(event.target);
    const from = String(form.get('from') || '');
    const to = String(form.get('to') || '');
    if (from && to && Date.parse(from) > Date.parse(to)) {
      showToast('结束时间必须晚于开始时间。', 'error');
      return;
    }
    store.patch({
      auditAction: String(form.get('action') || '').trim(),
      verificationEvent: String(form.get('event') || ''),
      verificationResultCode: String(form.get('resultCode') || '').trim(),
      logFrom: from,
      logTo: to,
      logPage: 1,
    });
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
