import {
  api,
  deviceLimitText,
  emptyState,
  escapeHtml,
  icon,
  isOwner,
  pageHeader,
  statusBadge,
  store,
} from './shared.js';

function formatPrice(cents) {
  return cents === 0 ? '人工确认' : `¥ ${(cents / 100).toFixed(2)}`;
}

// Author: 花落. Product and storefront view rendering is modular and MIT licensed.
export async function renderProductsView() {
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
