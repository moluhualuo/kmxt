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
import { renderModelArtifactsView } from './views/model-artifacts.js';
import { renderAnnouncementsView } from './views/announcements.js';
import { renderLicensesView } from './views/licenses.js';
import { renderOnlineDevicesView } from './views/online-devices.js';
import { renderProductsView } from './views/products.js';
import { renderOrdersView } from './views/orders.js';
import { renderUsersView } from './views/users.js';
import { renderLogsView } from './views/logs.js';

const appRoot = document.querySelector('#app');
const VIEW_LABELS = Object.freeze({
  overview: ['总览', '授权业务概况'],
  merchants: ['商户', '平台租户管理'],
  applications: ['程序', '程序与授权策略'],
  modelArtifacts: ['模型制品', '加密模型版本与交付状态'],
  announcements: ['公告', '客户端签名公告与版本策略'],
  licenses: ['卡密', '卡密与设备绑定'],
  onlineDevices: ['在线设备', '客户端在线状态与会话控制'],
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
    ARTIFACT_EXISTS: '当前程序已经存在同名且同版本的模型制品。',
    ARTIFACT_NOT_FOUND: '模型制品不存在或已被移除。',
    ARTIFACT_REVOKED: '模型制品已被吊销，不能恢复；请登记新版本。',
    ARTIFACT_UNAVAILABLE: '模型制品尚未启用或已被吊销。',
    INVALID_INPUT: '提交的数据格式不符合要求，请检查后重试。',
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
    { id: 'modelArtifacts', icon: 'package-check', label: '模型制品' },
    { id: 'announcements', icon: 'megaphone', label: '公告' },
    { id: 'licenses', icon: 'key-round', label: '卡密' },
    { id: 'onlineDevices', icon: 'monitor-smartphone', label: '在线设备' },
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
      case 'modelArtifacts': html = await renderModelArtifactsView(); break;
      case 'announcements': html = await renderAnnouncementsView(); break;
      case 'licenses': html = await renderLicensesView(); break;
      case 'onlineDevices': html = await renderOnlineDevicesView(); break;
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
    modelArtifactStatus: '',
    modelArtifacts: [],
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

function openChangeUserRole(userId, username, currentRole) {
  // 花落 / MIT：角色只在操作员与商户管理员之间调整，平台管理员账号不出现在商户账号列表里。
  const options = [
    { value: 'operator', label: '操作员（只读）' },
    { value: 'merchant_admin', label: '商户管理员（可写）' },
  ];
  openFormDialog({
    title: `修改 ${username} 的角色`,
    submitLabel: '保存角色',
    content: `<div class="form-stack">
      <div class="field"><label for="user-role-select">角色</label><select class="select" id="user-role-select" name="role" autofocus>
        ${options.map((item) => `<option value="${item.value}" ${item.value === currentRole ? 'selected' : ''}>${item.label}</option>`).join('')}
      </select><span class="field-hint">商户管理员可发卡、改程序设置与发布公告；操作员只能查看。保存后该账号的登录会话会立即失效，需要重新登录。</span></div>
    </div>`,
    onSubmit: async (form) => {
      const role = form.get('role');
      if (role === currentRole) {
        throw new Error('角色未变化。');
      }
      let result;
      try {
        result = await api.patch(`/api/v1/users/${encodeURIComponent(userId)}/role`, { role });
      } catch (error) {
        throw new Error(friendlyError(error));
      }
      showToast(`${username} 已设为${roleLabel(result.user.role)}，已撤销 ${result.sessionsRevoked} 个会话。`);
      await renderCurrentView();
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
  // 花落 / MIT：后端 presentApplication 把绑定与版本策略分别放在 binding / release 下；
  // 老响应可能不含这两个对象，回填时一律兜空对象，避免表单因 undefined 直接抛错。
  const binding = application.binding || {};
  const release = application.release || {};
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
      <div class="field full"><h3 class="form-section-title">防重打包绑定</h3><p class="field-hint">登记后，服务端会强制校验客户端上报的包名与签名证书；不匹配一律拒绝授权。留空表示不校验该项。</p></div>
      <div class="field"><label for="app-edit-package">Android 包名</label><input class="input mono" id="app-edit-package" name="androidPackage" maxlength="255" placeholder="com.example.app" value="${escapeHtml(binding.androidPackage || '')}"></div>
      <div class="field"><label for="app-edit-min-version">最低可用 versionCode</label><input class="input" id="app-edit-min-version" name="minVersionCode" type="number" min="1" max="2100000000" value="${binding.minVersionCode ?? ''}"><span class="field-hint">低于此版本的客户端会被服务端以 426 拒绝，无法使用。</span></div>
      <div class="field full"><label for="app-edit-certs">签名证书 SHA-256（每行一条，最多 8 条）</label><textarea class="textarea mono" id="app-edit-certs" name="signingCertificates" rows="3" placeholder="每行 64 位十六进制摘要">${escapeHtml((binding.signingCertificates || []).join('\n'))}</textarea></div>
      <div class="field full"><h3 class="form-section-title">最新版本与更新提示</h3><p class="field-hint">仅用于客户端展示引导，不参与放行判断。最低版本不得高于最新版本，否则全部用户都会被锁死。</p></div>
      <div class="field"><label for="app-edit-latest-code">最新 versionCode</label><input class="input" id="app-edit-latest-code" name="latestVersionCode" type="number" min="1" max="2100000000" value="${release.latestVersionCode ?? ''}"></div>
      <div class="field"><label for="app-edit-latest-name">最新版本号</label><input class="input" id="app-edit-latest-name" name="latestVersionName" maxlength="64" placeholder="1.2.0" value="${escapeHtml(release.latestVersionName || '')}"></div>
      <div class="field full"><label for="app-edit-release-notes">更新说明</label><textarea class="textarea" id="app-edit-release-notes" name="releaseNotes" maxlength="2000" rows="3" placeholder="纯文本，可换行分段">${escapeHtml(release.releaseNotes || '')}</textarea></div>
    </div>`,
    onSubmit: async (form) => {
      // 花落 / MIT：空输入统一送 null（清除登记），而不是省略字段或送空串。
      // 服务端把 undefined 当「不修改」、null 当「清除」，两者语义不同；
      // 送空串会撞上 min 长度校验直接报错，管理员就没法取消已有登记。
      const optionalText = (field) => {
        const value = String(form.get(field) ?? '').trim();
        return value === '' ? null : value;
      };
      const optionalCount = (field) => {
        const value = String(form.get(field) ?? '').trim();
        return value === '' ? null : Number(value);
      };
      const certificates = String(form.get('signingCertificates') ?? '')
        .split('\n')
        .map((line) => line.trim().toLowerCase())
        .filter((line) => line !== '');
      const updated = await api.patch(`/api/v1/apps/${encodeURIComponent(application.id)}`, {
        name: form.get('name'),
        description: form.get('description') || '',
        settings: {
          defaultDurationDays: Number(form.get('defaultDurationDays')),
          defaultMaxDevices: Number(form.get('defaultMaxDevices')),
          heartbeatSeconds: Number(form.get('heartbeatSeconds')),
          offlineGraceSeconds: Number(form.get('offlineGraceSeconds')),
        },
        androidPackage: optionalText('androidPackage'),
        minVersionCode: optionalCount('minVersionCode'),
        signingCertificates: certificates.length ? certificates : null,
        latestVersionCode: optionalCount('latestVersionCode'),
        latestVersionName: optionalText('latestVersionName'),
        releaseNotes: optionalText('releaseNotes'),
      });
      store.patch({ applications: store.value.applications.map((item) => item.id === updated.id ? updated : item) });
      showToast('程序设置已保存，签名密钥未变更。');
      renderShell();
      await renderCurrentView();
    },
  });
}

/**
 * 公告表单。新建与编辑共用，编辑时回填现有内容。
 *
 * 花落 / MIT：公告正文会被程序私钥签名后下发到全部客户端，所以这里只收纯文本，
 * 不提供富文本、链接或图片能力。服务端会再拒收 < > 与控制字符，前端不做转义后放行，
 * 以免管理员误以为可以写 HTML。datetime-local 的值是本地时间，提交前转成 ISO 字符串。
 */
function openAnnouncementForm(announcement = null) {
  const application = store.application;
  if (!application || !isOwner()) return;
  // datetime-local 需要 "YYYY-MM-DDTHH:mm" 本地时间格式，不能直接塞 ISO(UTC) 字符串，
  // 否则会按 UTC 数值显示成错误的本地时间。
  const toLocalInput = (value) => {
    if (!value) return '';
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return '';
    const date = new Date(timestamp - new Date(timestamp).getTimezoneOffset() * 60000);
    return date.toISOString().slice(0, 16);
  };
  const severity = announcement?.severity || 'info';
  const placement = ['both', 'gate', 'app'].includes(announcement?.placement)
    ? announcement.placement
    : 'both';
  openFormDialog({
    title: announcement ? '编辑公告' : '新建公告',
    submitLabel: announcement ? '保存公告' : '创建公告',
    wide: true,
    content: `<div class="form-grid">
      <div class="field full"><label for="announcement-title">标题</label><input class="input" id="announcement-title" name="title" minlength="1" maxlength="100" value="${escapeHtml(announcement?.title || '')}" required autofocus><span class="field-hint">单行纯文本，不支持 HTML 或链接。</span></div>
      <div class="field full"><label for="announcement-body">正文</label><textarea class="textarea" id="announcement-body" name="body" maxlength="2000" rows="6" required placeholder="纯文本，可换行分段，最多 20 段">${escapeHtml(announcement?.body || '')}</textarea></div>
      <div class="field"><label for="announcement-severity">级别</label><select class="select" id="announcement-severity" name="severity">
        <option value="info" ${severity === 'info' ? 'selected' : ''}>普通</option>
        <option value="warning" ${severity === 'warning' ? 'selected' : ''}>提醒</option>
        <option value="critical" ${severity === 'critical' ? 'selected' : ''}>重要</option>
      </select></div>
      <div class="field"><label for="announcement-placement">展示位置</label><select class="select" id="announcement-placement" name="placement">
        <option value="both" ${placement === 'both' ? 'selected' : ''}>全部页面</option>
        <option value="gate" ${placement === 'gate' ? 'selected' : ''}>仅卡密验证页</option>
        <option value="app" ${placement === 'app' ? 'selected' : ''}>仅软件内</option>
      </select><span class="field-hint">「仅软件内」的公告不会出现在验证页，用户激活进入软件后才看到。</span></div>
      <div class="field"><label for="announcement-starts">生效时间（可空）</label><input class="input" id="announcement-starts" name="startsAt" type="datetime-local" value="${escapeHtml(toLocalInput(announcement?.startsAt))}"><span class="field-hint">留空表示立即生效。</span></div>
      <div class="field"><label for="announcement-ends">结束时间（可空）</label><input class="input" id="announcement-ends" name="endsAt" type="datetime-local" value="${escapeHtml(toLocalInput(announcement?.endsAt))}"><span class="field-hint">留空表示长期有效，必须晚于生效时间。</span></div>
    </div>`,
    onSubmit: async (form) => {
      const toIso = (field) => {
        const value = String(form.get(field) ?? '').trim();
        if (value === '') return null;
        const timestamp = Date.parse(value);
        if (!Number.isFinite(timestamp)) return null;
        return new Date(timestamp).toISOString();
      };
      const payload = {
        title: form.get('title'),
        body: form.get('body'),
        severity: form.get('severity'),
        placement: form.get('placement'),
        startsAt: toIso('startsAt'),
        endsAt: toIso('endsAt'),
      };
      if (announcement) {
        await api.patch(`/api/v1/announcements/${encodeURIComponent(announcement.id)}`, payload);
        showToast('公告已保存。');
      } else {
        await api.post(`/api/v1/apps/${encodeURIComponent(application.id)}/announcements`, payload);
        showToast('公告已创建，当前为草稿，发布后才会下发。');
      }
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

// 花落/MIT: 批量上传并自动加密模型文件，逐个调用 /api/v1/admin/artifacts/upload。
function openUploadModelArtifact() {
  const application = store.application;
  if (!application || !isOwner()) return;
  openFormDialog({
    title: '上传并加密制品',
    submitLabel: '开始上传',
    wide: true,
    content: `<div class="form-stack">
      <p class="field-hint">可一次选择多个明文文件批量上传，服务端逐个加密并生成下载密文。支持模型（.onnx/.param/.bin/.tflite/.dlc）、原生库（.so）与代码（.dex）；名称/格式/大小自动从每个文件推断，内容密钥 DEK 仅服务端保存。</p>
      <div class="form-grid">
        <div class="field full"><label for="upload-file">制品文件（明文，可多选）</label><input type="file" class="input" id="upload-file" name="file" accept=".onnx,.param,.bin,.tflite,.dlc,.so,.dex" multiple required autofocus></div>
        <div class="field"><label for="upload-version">版本（可选，默认 1.0）</label><input class="input mono" id="upload-version" name="version" minlength="1" maxlength="64" placeholder="1.0"></div>
        <div class="field"><label for="upload-edition">版本分层（可选）</label><input class="input" id="upload-edition" name="edition" maxlength="32" placeholder="例如 paid"></div>
        <div class="field"><label for="upload-key-version">密钥版本</label><input class="input" id="upload-key-version" name="keyVersion" type="number" min="1" max="1000000" step="1" value="1" required></div>
      </div>
      <div id="upload-progress" class="field-hint" aria-live="polite"></div>
    </div>`,
    onSubmit: async (form) => {
      const fileInput = document.getElementById('upload-file');
      const files = Array.from(fileInput?.files || []);
      if (!files.length) throw new Error('请选择至少一个文件');
      const version = String(form.get('version') || '').trim();
      const edition = String(form.get('edition') || '').trim();
      const keyVersion = String(form.get('keyVersion') || '1');
      const progress = document.getElementById('upload-progress');
      const failures = [];
      let done = 0;
      for (const file of files) {
        if (progress) progress.textContent = `正在上传 ${done + 1}/${files.length}：${file.name}`;
        const formData = new FormData();
        formData.append('appId', application.id);
        if (version) formData.append('version', version);
        if (edition) formData.append('edition', edition);
        formData.append('keyVersion', keyVersion);
        formData.append('file', file);
        try {
          const response = await fetch('/api/v1/admin/artifacts/upload', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${sessionStorage.getItem('kmxt.admin.token') || ''}` },
            body: formData,
          });
          if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.error?.message || `HTTP ${response.status}`);
          }
          const result = await response.json();
          if (!result.success) throw new Error(result.error?.message || '未知错误');
          // 花落/MIT: 服务端不存密文，加密后的 .vmp 以 base64 回传，此处触发浏览器下载。
          const vmpBase64 = result.data?.vmpBase64;
          if (vmpBase64) {
            const binary = atob(vmpBase64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
            const blob = new Blob([bytes], { type: 'application/octet-stream' });
            const objectUrl = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = objectUrl;
            anchor.download = result.data?.vmpFilename || `${file.name}.vmp`;
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            URL.revokeObjectURL(objectUrl);
          }
          done += 1;
        } catch (error) {
          failures.push(`${file.name}: ${friendlyError(error)}`);
        }
      }
      await renderCurrentView();
      if (failures.length) {
        throw new Error(`成功 ${done}/${files.length}，失败：\n${failures.join('\n')}`);
      }
      showToast(`已加密并登记 ${done} 个模型为草稿。`);
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
  const { action, id, status, mode, licenseId, username, role } = button.dataset;

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
  } else if (action === 'change-user-role') {
    openChangeUserRole(id, username, role);
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
  } else if (action === 'upload-model-artifact') {
    openUploadModelArtifact();
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
  } else if (action === 'select-app-models') {
    store.patch({ selectedAppId: id, modelArtifactStatus: '', modelArtifacts: [], view: 'modelArtifacts' });
    location.hash = 'modelArtifacts';
    renderShell();
    await renderCurrentView();
  } else if (action === 'select-app-announcements') {
    store.patch({ selectedAppId: id, announcements: [], view: 'announcements' });
    location.hash = 'announcements';
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
  } else if (action === 'set-model-artifact-status') {
    const nextStatus = status;
    const statusCopy = {
      draft: {
        title: '退回模型草稿',
        message: '制品退回草稿后不会签发新的模型租约，已经签发的租约仍会在自身到期前有效。',
        confirmLabel: '确认退回草稿',
      },
      active: {
        title: '激活模型制品',
        message: '激活后，持有有效卡密和设备会话的客户端可以申请该制品的短期租约。',
        confirmLabel: '确认激活',
      },
      revoked: {
        title: '吊销模型制品',
        message: '吊销会立即撤销该制品已有的活动租约，客户端将无法继续申请新的租约。',
        confirmLabel: '确认吊销',
      },
    }[nextStatus];
    if (!statusCopy) return;
    const confirmed = await confirmAction(statusCopy);
    if (confirmed) await performAction(async () => {
      await api.patch(`/api/v1/artifacts/${encodeURIComponent(id)}/status`, { status: nextStatus });
      showToast(nextStatus === 'active' ? '模型制品已激活。' : nextStatus === 'draft' ? '模型制品已退回草稿。' : '模型制品已吊销。');
      await renderCurrentView();
    });
  } else if (action === 'create-announcement') {
    openAnnouncementForm(null);
  } else if (action === 'edit-announcement') {
    const announcement = (store.value.announcements || []).find((item) => item.id === id);
    if (announcement) openAnnouncementForm(announcement);
  } else if (action === 'toggle-announcement') {
    // 花落 / MIT：发布会让公告立刻进入签名载荷下发到全部客户端，因此二次确认；
    // 撤回只影响后续下发，已经拿到旧签名信封的客户端在新鲜度窗口内仍可能展示。
    const nextStatus = status === 'published' ? 'draft' : 'published';
    const confirmed = await confirmAction(nextStatus === 'published'
      ? { title: '发布公告', message: '发布后该公告会经程序私钥签名下发到全部客户端，请确认内容无误。', confirmLabel: '确认发布' }
      : { title: '撤回为草稿', message: '撤回后不再下发新公告，但已下发的签名信封在客户端新鲜度窗口内仍可能显示。', confirmLabel: '确认撤回' });
    if (confirmed) await performAction(async () => {
      await api.patch(`/api/v1/announcements/${encodeURIComponent(id)}/status`, { status: nextStatus });
      showToast(nextStatus === 'published' ? '公告已发布。' : '公告已撤回为草稿。');
      await renderCurrentView();
    });
  } else if (action === 'delete-announcement') {
    const confirmed = await confirmAction({ title: '删除公告', message: '删除后不可恢复。公告序号不会回退，删除不会影响后续公告的防回滚校验。', confirmLabel: '确认删除' });
    if (confirmed) await performAction(async () => {
      await api.delete(`/api/v1/announcements/${encodeURIComponent(id)}`);
      showToast('公告已删除。');
      await renderCurrentView();
    });
  } else if (action === 'delete-model-artifact') {
    const confirmed = await confirmAction({ title: '删除模型制品', message: '删除后将清除该制品的加密参数和租约记录，此操作不可恢复。只有草稿和已吊销的制品可以删除。', confirmLabel: '确认删除' });
    if (confirmed) await performAction(async () => {
      await api.delete(`/api/v1/artifacts/${encodeURIComponent(id)}`);
      showToast('模型制品已删除。');
      await renderCurrentView();
    });
  } else if (action === 'copy-model-artifact-id') {
    await performAction(async () => {
      const uuid = button.dataset.value || id;
      const name = button.dataset.name || '';
      const version = button.dataset.version || '';
      const label = [name, version && `v${version}`].filter(Boolean).join(' ');
      const text = label ? `${label}\n${uuid}` : uuid;
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const helper = document.createElement('textarea');
        helper.value = text;
        document.body.appendChild(helper);
        helper.select();
        document.execCommand('copy');
        helper.remove();
      }
      showToast(label ? `已复制「${label}」及其 UUID。` : '制品 UUID 已复制。');
    });
  } else if (action === 'bulk-delete-model-artifacts') {
    const artifactIds = [...new Set(store.value.selectedArtifactIds || [])];
    if (!artifactIds.length) {
      showToast('请先选择要删除的制品。', 'error');
      return;
    }
    const confirmed = await confirmAction({ title: '批量删除模型制品', message: `将删除已选 ${artifactIds.length} 个制品，并清除其加密参数与租约记录，此操作不可恢复。只有草稿和已吊销的制品可以删除。`, confirmLabel: '确认批量删除' });
    if (confirmed) await performAction(async () => {
      const results = await Promise.allSettled(artifactIds.map((artifactId) => api.delete(`/api/v1/artifacts/${encodeURIComponent(artifactId)}`)));
      const deletedCount = results.filter((item) => item.status === 'fulfilled').length;
      const failedCount = results.length - deletedCount;
      store.patch({ selectedArtifactIds: [] });
      const message = failedCount
        ? `已删除 ${deletedCount} 个，${failedCount} 个未删除。`
        : `已删除 ${deletedCount} 个模型制品。`;
      showToast(message, failedCount ? 'error' : 'success');
      await renderCurrentView();
    });
  } else if (action === 'bulk-export-model-artifacts') {
    const selectedSet = new Set(store.value.selectedArtifactIds || []);
    const chosen = (store.value.modelArtifacts || []).filter((artifact) => selectedSet.has(artifact.id));
    if (!chosen.length) {
      showToast('请先选择要导出的制品。', 'error');
      return;
    }
    await performAction(async () => {
      const exported = {
        exportedAt: new Date().toISOString(),
        application: store.application ? { id: store.application.id, name: store.application.name, code: store.application.code } : null,
        count: chosen.length,
        artifacts: chosen.map((artifact) => ({
          uuid: artifact.id,
          name: artifact.name,
          version: artifact.version,
          edition: artifact.edition || null,
          format: artifact.format,
          status: artifact.status,
        })),
      };
      const blob = new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      link.href = url;
      link.download = `model-artifacts-${stamp}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      showToast(`已导出 ${chosen.length} 个制品的 UUID 到 JSON 文件。`);
    });
  } else if (action === 'bulk-activate-model-artifacts') {
    const selectedSet = new Set(store.value.selectedArtifactIds || []);
    const targetIds = (store.value.modelArtifacts || [])
      .filter((artifact) => selectedSet.has(artifact.id) && artifact.status === 'draft')
      .map((artifact) => artifact.id);
    if (!targetIds.length) {
      showToast('已选制品中没有可启用的草稿制品。', 'error');
      return;
    }
    const confirmed = await confirmAction({ title: '批量启用模型制品', message: `将启用已选中的 ${targetIds.length} 个草稿制品，启用后持有有效卡密和设备会话的客户端可申请其租约。`, confirmLabel: '确认批量启用' });
    if (confirmed) await performAction(async () => {
      const results = await Promise.allSettled(targetIds.map((artifactId) => api.patch(`/api/v1/artifacts/${encodeURIComponent(artifactId)}/status`, { status: 'active' })));
      const okCount = results.filter((item) => item.status === 'fulfilled').length;
      const failedCount = results.length - okCount;
      store.patch({ selectedArtifactIds: [] });
      showToast(failedCount ? `已启用 ${okCount} 个，${failedCount} 个未启用。` : `已启用 ${okCount} 个模型制品。`, failedCount ? 'error' : 'success');
      await renderCurrentView();
    });
  } else if (action === 'bulk-revoke-model-artifacts') {
    const selectedSet = new Set(store.value.selectedArtifactIds || []);
    const targetIds = (store.value.modelArtifacts || [])
      .filter((artifact) => selectedSet.has(artifact.id) && (artifact.status === 'draft' || artifact.status === 'active'))
      .map((artifact) => artifact.id);
    if (!targetIds.length) {
      showToast('已选制品中没有可吊销的草稿或已启用制品。', 'error');
      return;
    }
    const confirmed = await confirmAction({ title: '批量吊销模型制品', message: `将吊销已选中的 ${targetIds.length} 个制品，吊销会立即撤销其活动租约，客户端无法继续申请新租约。`, confirmLabel: '确认批量吊销' });
    if (confirmed) await performAction(async () => {
      const results = await Promise.allSettled(targetIds.map((artifactId) => api.patch(`/api/v1/artifacts/${encodeURIComponent(artifactId)}/status`, { status: 'revoked' })));
      const okCount = results.filter((item) => item.status === 'fulfilled').length;
      const failedCount = results.length - okCount;
      store.patch({ selectedArtifactIds: [] });
      showToast(failedCount ? `已吊销 ${okCount} 个，${failedCount} 个未吊销。` : `已吊销 ${okCount} 个模型制品。`, failedCount ? 'error' : 'success');
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
  } else if (action === 'disconnect-device') {
    const confirmed = await confirmAction({ title: '强制设备下线', message: '将立即撤销该设备的全部客户端会话，但保留设备绑定。客户端需要重新激活后才能继续使用。', confirmLabel: '确认下线' });
    if (confirmed) await performAction(async () => {
      const result = await api.post(`/api/v1/device-bindings/${encodeURIComponent(id)}/disconnect`, {});
      showToast(result.disconnectedSessions > 0 ? `设备已下线，撤销 ${result.disconnectedSessions} 个会话。` : '设备当前已离线。');
      await renderCurrentView();
    });
  } else if (action === 'clear-online-device-filters') {
    store.patch({ onlineDeviceStatus: 'online', onlineDeviceSearch: '', onlineDevicePage: 1 });
    await renderCurrentView();
  } else if (action === 'license-page-previous' || action === 'license-page-next') {
    store.patch({ licensePage: Math.max(1, store.value.licensePage + (action.endsWith('next') ? 1 : -1)), selectedLicenseIds: [] });
    await renderCurrentView();
  } else if (action === 'order-page-previous' || action === 'order-page-next') {
    store.patch({ orderPage: Math.max(1, store.value.orderPage + (action.endsWith('next') ? 1 : -1)) });
    await renderCurrentView();
  } else if (action === 'log-page-previous' || action === 'log-page-next') {
    store.patch({ logPage: Math.max(1, store.value.logPage + (action.endsWith('next') ? 1 : -1)) });
    await renderCurrentView();
  } else if (action === 'online-device-page-previous' || action === 'online-device-page-next') {
    store.patch({ onlineDevicePage: Math.max(1, store.value.onlineDevicePage + (action.endsWith('next') ? 1 : -1)) });
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
  } else if (event.target.id === 'model-artifact-app-context') {
    store.patch({ selectedAppId: event.target.value || null, modelArtifactStatus: '', modelArtifacts: [] });
    await renderCurrentView();
  } else if (event.target.id === 'announcement-app-context') {
    store.patch({ selectedAppId: event.target.value || null, announcements: [] });
    await renderCurrentView();
  } else if (event.target.id === 'model-artifact-status-filter') {
    store.patch({ modelArtifactStatus: event.target.value || '' });
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
  } else if (event.target.id === 'model-artifact-select-all') {
    const ids = [...document.querySelectorAll('[data-artifact-select]')].map((input) => input.value);
    store.patch({ selectedArtifactIds: event.target.checked ? ids : [] });
    await renderCurrentView();
  } else if (event.target.matches('[data-artifact-select]')) {
    const selected = new Set(store.value.selectedArtifactIds || []);
    event.target.checked ? selected.add(event.target.value) : selected.delete(event.target.value);
    store.patch({ selectedArtifactIds: [...selected] });
    // 导出/启用/吊销/删除四个按钮各按状态计数，重渲染以同步全部按钮与全选态
    await renderCurrentView();
  } else if (event.target.id === 'online-device-app-context') {
    store.patch({ selectedAppId: event.target.value || null, onlineDevicePage: 1 });
    await renderCurrentView();
  } else if (event.target.id === 'online-device-status-filter') {
    store.patch({ onlineDeviceStatus: event.target.value, onlineDevicePage: 1 });
    await renderCurrentView();
  } else if (event.target.id === 'online-device-limit') {
    const limit = Number.parseInt(event.target.value || '20', 10);
    store.patch({ onlineDeviceLimit: [20, 50, 100].includes(limit) ? limit : 20, onlineDevicePage: 1 });
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
    store.patch({ licenseSearch: String(form.get('key') || '').trim(), licensePage: 1, selectedLicenseIds: [] });
    await renderCurrentView();
  } else if (event.target.id === 'online-device-search-form') {
    event.preventDefault();
    const form = new FormData(event.target);
    store.patch({ onlineDeviceSearch: String(form.get('search') || '').trim(), onlineDevicePage: 1 });
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
