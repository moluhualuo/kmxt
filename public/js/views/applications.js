import { deviceLimitText, emptyState, escapeHtml, icon, isOwner, pageHeader, statusBadge, store } from './shared.js';

// Author: 花落. Application settings view rendering is modular and MIT licensed.
export async function renderApplicationsView() {
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
      <button class="button secondary small" type="button" data-action="select-app-models" data-id="${escapeHtml(application.id)}">${icon('package-check')}模型</button>
      <button class="button secondary small" type="button" data-action="download-client-config" data-format="json" data-id="${escapeHtml(application.id)}" data-code="${escapeHtml(application.code)}">JSON</button>
      <button class="button secondary small" type="button" data-action="download-client-config" data-format="hpp" data-id="${escapeHtml(application.id)}" data-code="${escapeHtml(application.code)}">HPP</button>
      ${isOwner() ? `<button class="icon-button" type="button" data-action="edit-app" data-id="${escapeHtml(application.id)}" aria-label="编辑 ${escapeHtml(application.name)}" title="编辑程序">${icon('pencil')}</button>` : ''}
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
