import {
  api,
  emptyState,
  escapeHtml,
  formatDate,
  icon,
  pageHeader,
  pagination,
  statusBadge,
  store,
} from './shared.js';

function formatWindow(seconds) {
  if (seconds % 60 === 0) return `${seconds / 60} 分钟`;
  return `${seconds} 秒`;
}

// Author: 花落. Online-device operations view is modular and distributed under the MIT License.
export async function renderOnlineDevicesView() {
  const application = store.application;
  const appSelector = `<select class="select" id="online-device-app-context" aria-label="当前程序">
    ${store.value.applications.length
      ? store.value.applications.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === store.value.selectedAppId ? 'selected' : ''}>${escapeHtml(item.name)} · ${escapeHtml(item.code)}</option>`).join('')
      : '<option value="">暂无程序</option>'}
  </select>`;
  if (!application) {
    return `${pageHeader('在线设备', '客户端在线状态与会话控制')}${emptyState('monitor-smartphone', '暂无程序', '请先创建程序后查看在线设备。')}`;
  }

  const limit = [20, 50, 100].includes(Number(store.value.onlineDeviceLimit))
    ? Number(store.value.onlineDeviceLimit)
    : 20;
  const query = new URLSearchParams({
    page: String(store.value.onlineDevicePage),
    limit: String(limit),
    status: store.value.onlineDeviceStatus || 'online',
  });
  if (store.value.onlineDeviceSearch) query.set('search', store.value.onlineDeviceSearch);
  const data = await api.get(`/api/v1/apps/${encodeURIComponent(application.id)}/online-devices?${query}`);
  const rows = data.items.map((device) => `<tr>
    <td><span class="cell-primary">${escapeHtml(device.deviceLabel)}</span><span class="cell-secondary mono">${escapeHtml(device.bindingId.slice(0, 8))}</span></td>
    <td>${statusBadge(device.status, device.online ? '在线' : '离线')}</td>
    <td><span class="cell-primary mono">${escapeHtml(device.licenseKeyPreview || '-')}</span><span class="cell-secondary mono">${escapeHtml(device.licenseId.slice(0, 8))}</span></td>
    <td><span class="cell-primary">${escapeHtml(device.clientVersion || '-')}</span><span class="cell-secondary mono">${escapeHtml(device.ipAddress || '-')}</span></td>
    <td>${formatDate(device.lastSeenAt)}</td>
    <td>${formatDate(device.sessionExpiresAt)}</td>
    <td><div class="inline-actions">
      <button class="icon-button danger" type="button" data-action="disconnect-device" data-id="${escapeHtml(device.bindingId)}" ${device.online ? '' : 'disabled'} aria-label="强制设备下线" title="强制下线">${icon('log-out')}</button>
    </div></td>
  </tr>`).join('');
  const hasFilters = store.value.onlineDeviceSearch || store.value.onlineDeviceStatus !== 'online';

  return `${pageHeader('在线设备', application.name, `<button class="button secondary" type="button" data-action="refresh">${icon('refresh-cw')}刷新状态</button>`)}
    <div class="metrics-grid device-metrics">
      <article class="metric-card"><div><small>当前在线</small><div class="metric-value">${data.summary.online}</div></div><span class="metric-icon">${icon('circle-check')}</span></article>
      <article class="metric-card"><div><small>当前离线</small><div class="metric-value">${data.summary.offline}</div></div><span class="metric-icon info">${icon('log-out')}</span></article>
      <article class="metric-card"><div><small>活动绑定</small><div class="metric-value">${data.summary.total}</div></div><span class="metric-icon">${icon('monitor-smartphone')}</span></article>
      <article class="metric-card"><div><small>在线判定窗口</small><div class="metric-value compact">${escapeHtml(formatWindow(data.summary.onlineWindowSeconds))}</div></div><span class="metric-icon info">${icon('clock-3')}</span></article>
    </div>
    <div class="toolbar section-header">
      <div class="inline-actions">${appSelector}
        <select class="select" id="online-device-status-filter" aria-label="在线状态">
          ${[
            ['online', '仅在线'],
            ['offline', '仅离线'],
            ['all', '全部设备'],
          ].map(([value, label]) => `<option value="${value}" ${store.value.onlineDeviceStatus === value ? 'selected' : ''}>${label}</option>`).join('')}
        </select>
        <label class="field-label" for="online-device-limit">每页</label>
        <select class="select" id="online-device-limit" aria-label="每页显示数量">
          ${[20, 50, 100].map((value) => `<option value="${value}" ${limit === value ? 'selected' : ''}>${value}</option>`).join('')}
        </select>
      </div>
      <form class="inline-actions" id="online-device-search-form">
        <label class="field-label" for="online-device-search">设备搜索</label>
        <input class="input" id="online-device-search" name="search" value="${escapeHtml(store.value.onlineDeviceSearch)}" placeholder="设备名 / 卡密 / IP / 版本">
        <button class="icon-button" type="submit" aria-label="搜索在线设备" title="搜索">${icon('search')}</button>
        ${hasFilters ? `<button class="icon-button" type="button" data-action="clear-online-device-filters" aria-label="清除筛选" title="清除筛选">${icon('x')}</button>` : ''}
      </form>
    </div>
    <div class="table-frame">
      ${rows ? `<div class="table-scroll"><table><thead><tr><th>设备</th><th>状态</th><th>卡密</th><th>版本 / IP</th><th>最后在线</th><th>会话到期</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div>` : emptyState('monitor-smartphone', '暂无匹配设备', '当前程序和筛选条件下没有设备记录。')}
      ${pagination(data, 'online-device-page')}
    </div>`;
}
