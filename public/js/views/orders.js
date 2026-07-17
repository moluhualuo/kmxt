import { api, emptyState, escapeHtml, formatDate, icon, pageHeader, pagination, statusBadge, store } from './shared.js';

// Author: 花落. Manual order review view rendering is modular and MIT licensed.
export async function renderOrdersView() {
  const merchant = store.merchant;
  if (!merchant) {
    return `${pageHeader('订单', '人工审核与发卡')}${emptyState('receipt-text', '未选择商户', '请先创建或选择商户。')}`;
  }
  const query = new URLSearchParams({ page: String(store.value.orderPage), limit: '20' });
  if (store.value.orderStatus) query.set('status', store.value.orderStatus);
  if (store.value.orderNo) query.set('orderNo', store.value.orderNo);
  if (store.value.orderFrom) query.set('from', new Date(store.value.orderFrom).toISOString());
  if (store.value.orderTo) query.set('to', new Date(store.value.orderTo).toISOString());
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
      <form class="inline-actions" id="order-filter-form">
        <label class="field-label" for="order-no-filter">订单号</label><input class="input mono" id="order-no-filter" name="orderNo" value="${escapeHtml(store.value.orderNo)}" placeholder="KMO-...">
        <label class="field-label" for="order-from-filter">开始</label><input class="input" id="order-from-filter" name="from" type="datetime-local" value="${escapeHtml(store.value.orderFrom)}">
        <label class="field-label" for="order-to-filter">结束</label><input class="input" id="order-to-filter" name="to" type="datetime-local" value="${escapeHtml(store.value.orderTo)}">
        <button class="icon-button" type="submit" aria-label="筛选订单" title="筛选订单">${icon('search')}</button>
        <button class="button ghost small" type="button" data-action="clear-order-filters">清除</button>
      </form>
    </div>
    <div class="table-frame">
      ${rows ? `<div class="table-scroll"><table><thead><tr><th>订单</th><th>商品</th><th>客户</th><th>状态</th><th>卡密</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div>` : emptyState('receipt-text', '暂无订单', '当前筛选条件下没有订单。')}
      ${pagination(data, 'order-page')}
    </div>`;
}
