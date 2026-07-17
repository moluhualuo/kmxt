import { api, emptyState, escapeHtml, formatDate, icon, isOwner, pageHeader, pagination, store } from './shared.js';

// Author: 花落. Audit and verification-log view rendering is modular and MIT licensed.
export async function renderLogsView() {
  const merchant = store.merchant;
  const application = store.application;
  const canAudit = isOwner();
  if (!canAudit && store.value.logMode === 'audit') {
    store.patch({ logMode: 'verification' });
  }
  const mode = store.value.logMode;
  let data = { items: [], total: 0, page: store.value.logPage, limit: 20 };
  const query = new URLSearchParams({ page: String(store.value.logPage), limit: '20' });
  if (store.value.logFrom) query.set('from', new Date(store.value.logFrom).toISOString());
  if (store.value.logTo) query.set('to', new Date(store.value.logTo).toISOString());
  if (mode === 'audit' && merchant) {
    if (store.value.auditAction) query.set('action', store.value.auditAction);
    data = await api.get(`/api/v1/merchants/${encodeURIComponent(merchant.id)}/audit-logs?${query}`);
  } else if (mode === 'verification' && application) {
    if (store.value.verificationEvent) query.set('event', store.value.verificationEvent);
    if (store.value.verificationResultCode) query.set('resultCode', store.value.verificationResultCode);
    data = await api.get(`/api/v1/apps/${encodeURIComponent(application.id)}/verification-logs?${query}`);
  }
  const controls = `<div class="segmented" role="tablist" aria-label="日志类型">
    ${canAudit ? `<button class="segment ${mode === 'audit' ? 'active' : ''}" type="button" data-action="log-mode" data-mode="audit" role="tab" aria-selected="${mode === 'audit'}">管理审计</button>` : ''}
    <button class="segment ${mode === 'verification' ? 'active' : ''}" type="button" data-action="log-mode" data-mode="verification" role="tab" aria-selected="${mode === 'verification'}">程序验证</button>
  </div>`;
  const rows = data.items.map((entry) => mode === 'audit'
    ? `<tr><td class="cell-primary">${escapeHtml(entry.action)}</td><td>${escapeHtml(entry.actorUsername)}</td><td>${escapeHtml(entry.resourceType)}</td><td class="mono">${escapeHtml(entry.resourceId?.slice(0, 8) || '-')}</td><td>${formatDate(entry.createdAt)}</td></tr>`
    : `<tr><td class="cell-primary">${escapeHtml(entry.event === 'activate' ? '激活' : '心跳')}</td><td class="mono">${escapeHtml(entry.licenseId.slice(0, 8))}</td><td class="mono">${escapeHtml(entry.bindingId.slice(0, 8))}</td><td>${escapeHtml(entry.clientVersion || '-')}</td><td>${formatDate(entry.createdAt)}</td></tr>`).join('');
  const filterControls = mode === 'audit'
    ? `<label class="field-label" for="audit-action-filter">动作</label><input class="input" id="audit-action-filter" name="action" value="${escapeHtml(store.value.auditAction)}" placeholder="例如 license.status.update">`
    : `<label class="field-label" for="verification-event-filter">事件</label><select class="select" id="verification-event-filter" name="event"><option value="">全部事件</option><option value="activate" ${store.value.verificationEvent === 'activate' ? 'selected' : ''}>激活</option><option value="verify" ${store.value.verificationEvent === 'verify' ? 'selected' : ''}>心跳</option></select><label class="field-label" for="verification-result-filter">结果</label><input class="input" id="verification-result-filter" name="resultCode" value="${escapeHtml(store.value.verificationResultCode)}" placeholder="LICENSE_VALID">`;
  const missingContext = mode === 'audit' ? !merchant : !application;
  return `${pageHeader('日志', mode === 'audit' ? (merchant?.name || '管理审计') : (application?.name || '程序验证'), controls)}
    <form class="toolbar section-header" id="log-filter-form">${filterControls}<label class="field-label" for="log-from-filter">开始</label><input class="input" id="log-from-filter" name="from" type="datetime-local" value="${escapeHtml(store.value.logFrom)}"><label class="field-label" for="log-to-filter">结束</label><input class="input" id="log-to-filter" name="to" type="datetime-local" value="${escapeHtml(store.value.logTo)}"><button class="icon-button" type="submit" aria-label="筛选日志" title="筛选日志">${icon('search')}</button><button class="button ghost small" type="button" data-action="clear-log-filters">清除</button></form>
    <div class="table-frame">
      ${rows ? `<div class="table-scroll"><table><thead><tr>${mode === 'audit' ? '<th>操作</th><th>执行账号</th><th>资源</th><th>资源 ID</th><th>时间</th>' : '<th>事件</th><th>卡密 ID</th><th>绑定 ID</th><th>版本</th><th>时间</th>'}</tr></thead><tbody>${rows}</tbody></table></div>` : emptyState('scroll-text', '暂无日志', missingContext ? '请先选择对应的商户或程序。' : '当前范围内没有日志。')}
      ${pagination(data, 'log-page')}
    </div>`;
}
