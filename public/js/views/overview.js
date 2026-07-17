// Author: 花落. KMXT admin overview view is provided under the MIT License.
export async function renderOverviewView(context) {
  const {
    api, store, pageHeader, icon, emptyState, escapeHtml, formatDate, isPlatformAdmin,
  } = context;
  const merchant = store.merchant;
  const application = store.application;
  const query = new URLSearchParams();
  if (merchant?.id) query.set('merchantId', merchant.id);
  if (application?.id) query.set('appId', application.id);
  const [dashboard, verification] = await Promise.all([
    api.get(`/api/v1/dashboard${query.size ? `?${query}` : ''}`),
    application
      ? api.get(`/api/v1/apps/${encodeURIComponent(application.id)}/verification-logs?page=1&limit=5`)
      : Promise.resolve({ items: [] }),
  ]);
  const actions = isPlatformAdmin() && !merchant
    ? `<button class="button" type="button" data-action="create-merchant">${icon('plus')}新建商户</button>`
    : `<button class="button" type="button" data-action="create-app" ${merchant ? '' : 'disabled'}>${icon('plus')}新建程序</button>`;
  const recentRows = verification.items.map((entry) => `<tr>
    <td class="cell-primary">${escapeHtml(entry.event === 'activate' ? '激活' : '心跳')}</td>
    <td><span class="mono">${escapeHtml(entry.licenseId.slice(0, 8))}</span></td>
    <td>${escapeHtml(entry.clientVersion || '-')}</td>
    <td>${formatDate(entry.createdAt)}</td>
  </tr>`).join('');
  const metrics = [
    ['商户', dashboard.merchants, 'building-2', ''],
    ['程序', dashboard.applications, 'boxes', 'info'],
    ['待审核订单', dashboard.pendingOrders, 'receipt-text', ''],
    ['卡密', dashboard.licenses, 'key-round', ''],
    ['有效绑定', dashboard.activeBindings, 'monitor-smartphone', 'info'],
    ['24 小时验证', `${dashboard.verification24h.successful}/${dashboard.verification24h.total}`, 'shield-check', 'info'],
  ].map(([label, value, iconName, tone]) => `<article class="metric-card"><div><small>${escapeHtml(label)}</small><div class="metric-value">${escapeHtml(value)}</div></div><span class="metric-icon ${tone}">${icon(iconName)}</span></article>`).join('');
  return `${pageHeader('业务总览', merchant ? merchant.name : '平台范围', actions)}
    <section class="metrics-grid" aria-label="业务指标">${metrics}</section>
    <section class="section">
      <div class="section-header"><h2>最近验证</h2>${application ? `<span class="cell-secondary">${escapeHtml(application.name)}</span>` : ''}</div>
      <div class="table-frame">
        ${application && recentRows ? `<div class="table-scroll"><table><thead><tr><th>事件</th><th>卡密 ID</th><th>客户端版本</th><th>时间</th></tr></thead><tbody>${recentRows}</tbody></table></div>` : emptyState('scroll-text', '暂无验证记录', application ? '当前程序尚无验证记录。' : '请先创建或选择程序。')}
      </div>
    </section>`;
}
