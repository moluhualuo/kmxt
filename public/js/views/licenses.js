import {
  api,
  deviceLimitText,
  emptyState,
  escapeHtml,
  formatDate,
  icon,
  isOwner,
  pageHeader,
  pagination,
  statusBadge,
  store,
} from './shared.js';

// Author: 花落. License list and filter view are modular MIT licensed components.
export async function renderLicensesView() {
  const application = store.application;
  const licenseLimit = [20, 50, 100].includes(Number(store.value.licenseLimit)) ? Number(store.value.licenseLimit) : 20;
  const appSelector = `<select class="select" id="license-app-context" aria-label="当前程序">
    ${store.value.applications.length ? store.value.applications.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === store.value.selectedAppId ? 'selected' : ''}>${escapeHtml(item.name)} · ${escapeHtml(item.code)}</option>`).join('') : '<option value="">暂无程序</option>'}
  </select>`;
  if (!application) {
    return `${pageHeader('卡密', '卡密与设备绑定')}${emptyState('key-round', '暂无程序', '请先创建程序。', isOwner() ? `<button class="button" type="button" data-view="applications">${icon('plus')}新建程序</button>` : '')}`;
  }
  const query = new URLSearchParams({ page: String(store.value.licensePage), limit: String(licenseLimit) });
  if (store.value.licenseStatus) query.set('status', store.value.licenseStatus);
  if (store.value.licenseSearch) query.set('key', store.value.licenseSearch);
  const data = await api.get(`/api/v1/apps/${encodeURIComponent(application.id)}/licenses?${query}`);
  const visibleIds = new Set(data.items.map((license) => license.id));
  const selectedIds = new Set((store.value.selectedLicenseIds || []).filter((id) => visibleIds.has(id)));
  const owner = isOwner();
  const selectedCount = selectedIds.size;
  const rows = data.items.map((license) => `<tr>
    ${owner ? `<td><input type="checkbox" data-license-select value="${escapeHtml(license.id)}" ${selectedIds.has(license.id) ? 'checked' : ''} aria-label="选择卡密 ${escapeHtml(license.keyPreview)}"></td>` : ''}
    <td><span class="cell-primary mono">${escapeHtml(license.keyPreview)}</span><span class="cell-secondary mono">${escapeHtml(license.id.slice(0, 8))}</span></td>
    <td>${statusBadge(license.status)}</td>
    <td>${license.durationDays ? `${license.durationDays} 天` : formatDate(license.fixedExpiresAt, { dateOnly: true })}</td>
    <td>${deviceLimitText(license.maxDevices)}</td>
    <td>${formatDate(license.expiresAt)}</td>
    <td><div class="inline-actions">
      ${owner ? `<button class="icon-button" type="button" data-action="reveal-license-key" data-id="${escapeHtml(license.id)}" aria-label="查看完整卡密" title="查看完整卡密">${icon('eye')}</button>` : ''}
      <button class="icon-button" type="button" data-action="show-devices" data-id="${escapeHtml(license.id)}" aria-label="查看设备" title="设备">${icon('monitor-smartphone')}</button>
      ${license.status !== 'expired' ? `<button class="icon-button" type="button" data-action="toggle-license" data-id="${escapeHtml(license.id)}" data-status="${escapeHtml(license.status)}" aria-label="${license.status === 'disabled' ? '启用' : '禁用'}卡密" title="${license.status === 'disabled' ? '启用' : '禁用'}">${icon(license.status === 'disabled' ? 'circle-check' : 'ban')}</button>` : ''}
      ${owner ? `<button class="icon-button danger" type="button" data-action="delete-license" data-id="${escapeHtml(license.id)}" aria-label="删除卡密" title="删除卡密">${icon('trash-2')}</button>` : ''}
    </div></td>
  </tr>`).join('');
  const bulkActions = owner ? `<button class="button danger" type="button" data-action="bulk-delete-licenses" ${selectedCount > 0 ? '' : 'disabled'}>${icon('trash-2')}批量删除${selectedCount > 0 ? `（${selectedCount}）` : ''}</button>` : '';
  const headerCheckbox = owner ? `<th><input type="checkbox" id="license-select-all" ${data.items.length && selectedCount === data.items.length ? 'checked' : ''} ${data.items.length ? '' : 'disabled'} aria-label="选择当前页全部卡密"></th>` : '';
  const rowHeader = `${headerCheckbox}<th>卡密</th><th>状态</th><th>有效期</th><th>设备上限</th><th>到期时间</th><th>操作</th>`;
  return `${pageHeader('卡密', application.name, `<div class="inline-actions">${bulkActions}<button class="button secondary" type="button" data-action="show-license-batches" data-id="${escapeHtml(application.id)}">${icon('key-round')}批次记录</button><button class="button" type="button" data-action="generate-licenses" ${application.status === 'active' ? '' : 'disabled'}>${icon('plus')}生成卡密</button></div>`)}
    <div class="toolbar section-header">
      <div class="inline-actions">${appSelector}
        <select class="select" id="license-status-filter" aria-label="卡密状态">
          <option value="">全部状态</option>
          ${['pending', 'active', 'disabled', 'expired'].map((status) => `<option value="${status}" ${store.value.licenseStatus === status ? 'selected' : ''}>${escapeHtml({ pending: '未激活', active: '启用', disabled: '已禁用', expired: '已到期' }[status])}</option>`).join('')}
        </select>
        <label class="field-label" for="license-limit">每页</label>
        <select class="select" id="license-limit" aria-label="每页显示数量">
          ${[20, 50, 100].map((limit) => `<option value="${limit}" ${licenseLimit === limit ? 'selected' : ''}>${limit}</option>`).join('')}
        </select>
      </div>
      <form class="inline-actions" id="license-search-form">
        <label class="field-label" for="license-search">精确卡密</label>
        <input class="input mono" id="license-search" name="key" value="${escapeHtml(store.value.licenseSearch)}" placeholder="KMXT-...">
        <button class="icon-button" type="submit" aria-label="查询卡密" title="查询">${icon('search')}</button>
      </form>
    </div>
    <div class="table-frame">
      ${rows ? `<div class="table-scroll"><table><thead><tr>${rowHeader}</tr></thead><tbody>${rows}</tbody></table></div>` : emptyState('key-round', '暂无卡密', '当前筛选条件下没有卡密。')}
      ${pagination(data, 'license-page')}
    </div>`;
}
