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
    <td><span class="event-mark ${entry.event === 'activate' ? 'activate' : 'heartbeat'}">${icon(entry.event === 'activate' ? 'circle-check' : 'clock-3')}</span><span class="cell-primary">${escapeHtml(entry.event === 'activate' ? '激活' : '心跳')}</span></td>
    <td><span class="mono">${escapeHtml(entry.licenseId.slice(0, 8))}</span></td>
    <td>${escapeHtml(entry.clientVersion || '-')}</td>
    <td>${formatDate(entry.createdAt)}</td>
  </tr>`).join('');
  const metrics = [
    ['商户', dashboard.merchants, 'building-2', 'primary', '租户空间'],
    ['程序', dashboard.applications, 'boxes', 'teal', '已接入应用'],
    ['待审核订单', dashboard.pendingOrders, 'receipt-text', dashboard.pendingOrders > 0 ? 'warning' : 'slate', '需要人工处理'],
    ['卡密总量', dashboard.licenses, 'key-round', 'violet', '已生成授权'],
    ['有效绑定', dashboard.activeBindings, 'monitor-smartphone', 'teal', '当前设备'],
    ['24 小时验证', `${dashboard.verification24h.successful}/${dashboard.verification24h.total}`, 'shield-check', 'primary', '成功 / 总数'],
  ].map(([label, value, iconName, tone, hint]) => `<article class="metric-card metric-${tone}">
      <div class="metric-top"><span class="metric-icon">${icon(iconName)}</span><span class="metric-trend">${escapeHtml(hint)}</span></div>
      <div class="metric-label">${escapeHtml(label)}</div>
      <div class="metric-value">${escapeHtml(value)}</div>
    </article>`).join('');
  const quickActions = `<div class="quick-actions">
      <button class="quick-action" type="button" data-action="create-app" ${merchant ? '' : 'disabled'}><span class="quick-action-icon">${icon('boxes')}</span><span><strong>新建程序</strong><small>配置授权策略</small></span>${icon('external-link')}</button>
      <button class="quick-action" type="button" data-view="licenses"><span class="quick-action-icon teal">${icon('key-round')}</span><span><strong>管理卡密</strong><small>生成与查看批次</small></span>${icon('external-link')}</button>
      <button class="quick-action" type="button" data-view="logs"><span class="quick-action-icon violet">${icon('scroll-text')}</span><span><strong>查看日志</strong><small>审计与验证记录</small></span>${icon('external-link')}</button>
    </div>`;
  const activity = application && recentRows
    ? `<div class="activity-list"><div class="table-scroll"><table><thead><tr><th>事件</th><th>卡密 ID</th><th>客户端版本</th><th>发生时间</th></tr></thead><tbody>${recentRows}</tbody></table></div></div>`
    : emptyState('scroll-text', '暂无验证记录', application ? '当前程序尚无验证记录，客户端首次激活后会显示在这里。' : '选择一个程序后即可查看实时验证活动。', application ? '' : `<button class="button secondary" type="button" data-view="applications">查看程序</button>`);
  return `${pageHeader('业务总览', merchant ? `${merchant.name} · ${merchant.code}` : '平台范围', actions)}
    <section class="overview-hero" aria-label="控制台摘要">
      <div class="overview-hero-copy"><span class="hero-status"><i></i> 系统运行正常</span><h2>授权业务，一目了然</h2><p>集中查看租户、程序、卡密和设备验证状态。</p></div>
      <div class="overview-hero-meta"><span>数据更新时间</span><strong>刚刚</strong><span class="hero-meta-dot"></span><span>自动刷新已开启</span></div>
    </section>
    <section class="metrics-grid overview-metrics" aria-label="业务指标">${metrics}</section>
    <section class="overview-columns">
      <section class="surface-panel activity-panel"><div class="panel-heading"><div><span class="panel-kicker">LIVE ACTIVITY</span><h2>最近验证</h2></div>${application ? `<span class="panel-context">${escapeHtml(application.name)}</span>` : ''}</div>${activity}</section>
      <aside class="surface-panel quick-panel"><div class="panel-heading"><div><span class="panel-kicker">SHORTCUTS</span><h2>快捷操作</h2></div></div>${quickActions}</aside>
    </section>`;
}
