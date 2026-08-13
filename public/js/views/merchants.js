import { emptyState, escapeHtml, formatDate, icon, pageHeader, statusBadge, store } from './shared.js';

// Author: 花落. Merchant view rendering is modular and MIT licensed.
export async function renderMerchantsView() {
  const rows = store.value.merchants.map((merchant) => `<tr>
    <td><span class="cell-primary">${escapeHtml(merchant.name)}</span><span class="cell-secondary mono">${escapeHtml(merchant.id.slice(0, 8))}</span></td>
    <td class="mono">${escapeHtml(merchant.code)}</td>
    <td>${statusBadge(merchant.status)}</td>
    <td>${formatDate(merchant.createdAt)}</td>
    <td><div class="inline-actions">
      <button class="button secondary small" type="button" data-action="select-merchant" data-id="${escapeHtml(merchant.id)}">${icon('settings-2')}管理</button>
      ${merchant.status === 'active'
    ? `<a class="button secondary small" href="/store/${encodeURIComponent(merchant.code)}" target="_blank" rel="noopener">${icon('external-link')}打开店铺</a>`
    : `<button class="button secondary small" type="button" disabled title="商户已停用">${icon('external-link')}店铺已停用</button>`}
      <button class="icon-button" type="button" data-action="edit-merchant" data-id="${escapeHtml(merchant.id)}" aria-label="编辑 ${escapeHtml(merchant.name)}" title="编辑商户">${icon('pencil')}</button>
      <button class="icon-button" type="button" data-action="toggle-merchant" data-id="${escapeHtml(merchant.id)}" data-status="${escapeHtml(merchant.status)}" aria-label="${merchant.status === 'active' ? '禁用' : '启用'}商户" title="${merchant.status === 'active' ? '禁用' : '启用'}">${icon(merchant.status === 'active' ? 'ban' : 'circle-check')}</button>
    </div></td>
  </tr>`).join('');
  return `${pageHeader('商户', '平台租户管理 · 可从此处进入管理或打开公开店铺', `<button class="button" type="button" data-action="create-merchant">${icon('plus')}新建商户</button>`)}
    <div class="table-frame">
      ${rows ? `<div class="table-scroll"><table><thead><tr><th>商户</th><th>代码</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div>` : emptyState('building-2', '暂无商户', '创建第一个商户后即可配置程序。', `<button class="button" type="button" data-action="create-merchant">${icon('plus')}新建商户</button>`) }
    </div>`;
}
