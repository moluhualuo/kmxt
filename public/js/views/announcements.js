import {
  api,
  emptyState,
  escapeHtml,
  formatDate,
  icon,
  isOwner,
  pageHeader,
  store,
} from './shared.js';

const SEVERITY_LABELS = { info: '提示', warning: '警告', critical: '重要' };

function severityLabel(severity) {
  return SEVERITY_LABELS[severity] || severity;
}

/**
 * 花落 / MIT：公告出了时间窗口仍然是 published，只是不再进入签名载荷。
 * 列表必须把「等待生效 / 已过期 / 正在下发」分开显示，否则会误判客户端没收到公告。
 */
function statusChip(announcement) {
  if (announcement.status !== 'published') {
    return `<span class="announcement-status draft">${icon('pencil')}草稿</span>`;
  }
  const now = Date.now();
  if (announcement.startsAt && Date.parse(announcement.startsAt) > now) {
    return `<span class="announcement-status inactive">${icon('clock-3')}等待生效</span>`;
  }
  if (announcement.endsAt && Date.parse(announcement.endsAt) <= now) {
    return `<span class="announcement-status inactive">${icon('clock-3')}已过期</span>`;
  }
  return `<span class="announcement-status active">${icon('circle-check')}正在下发</span>`;
}

function announcementCard(announcement) {
  const severity = SEVERITY_LABELS[announcement.severity] ? announcement.severity : 'info';
  const published = announcement.status === 'published';
  const ownerActions = isOwner()
    ? `<button class="icon-button" type="button" data-action="edit-announcement" data-id="${escapeHtml(announcement.id)}" aria-label="编辑公告" title="编辑">${icon('pencil')}</button>
      <button class="icon-button" type="button" data-action="toggle-announcement" data-id="${escapeHtml(announcement.id)}" data-status="${escapeHtml(announcement.status)}" aria-label="${published ? '撤回为草稿' : '发布公告'}" title="${published ? '撤回为草稿' : '发布'}">${icon(published ? 'ban' : 'circle-check')}</button>
      <button class="icon-button" type="button" data-action="delete-announcement" data-id="${escapeHtml(announcement.id)}" aria-label="删除公告" title="删除">${icon('trash-2')}</button>`
    : '';
  return `<article class="announcement-card severity-${severity}">
    <div class="announcement-header">
      <div class="announcement-meta">
        <span class="announcement-sequence">#${announcement.sequence}</span>
        <span class="announcement-severity ${severity}">${escapeHtml(severityLabel(announcement.severity))}</span>
        ${statusChip(announcement)}
      </div>
      <div class="inline-actions">${ownerActions}</div>
    </div>
    <h3 class="announcement-title">${escapeHtml(announcement.title)}</h3>
    <p class="announcement-body">${escapeHtml(announcement.body).replace(/\n/g, '<br>')}</p>
    <div class="announcement-footer">
      <span>${icon('clock-3')}创建于 ${escapeHtml(formatDate(announcement.createdAt))}</span>
      ${announcement.startsAt ? `<span>${icon('clock-3')}生效 ${escapeHtml(formatDate(announcement.startsAt))}</span>` : ''}
      ${announcement.endsAt ? `<span>${icon('clock-3')}结束 ${escapeHtml(formatDate(announcement.endsAt))}</span>` : ''}
      ${announcement.publishedAt ? `<span>${icon('circle-check')}发布于 ${escapeHtml(formatDate(announcement.publishedAt))}</span>` : ''}
    </div>
  </article>`;
}

// Author: 花落. Announcement view rendering is modular and MIT licensed.
export async function renderAnnouncementsView() {
  const application = store.application;
  const appSelector = `<select class="select" id="announcement-app-context" aria-label="当前程序">
    ${store.value.applications.length ? store.value.applications.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === store.value.selectedAppId ? 'selected' : ''}>${escapeHtml(item.name)} · ${escapeHtml(item.code)}</option>`).join('') : '<option value="">暂无程序</option>'}
  </select>`;
  if (!application) {
    return `${pageHeader('公告', '客户端签名公告与版本策略')}${emptyState('megaphone', '暂无程序', '请先创建或选择程序，再管理公告。')}`;
  }
  const announcements = await api.get(`/api/v1/apps/${encodeURIComponent(application.id)}/announcements`);
  // 编辑动作在 app.js 里按 id 从 store 回查，不再重复请求接口，因此这里必须写回。
  store.patch({ announcements });
  const createButton = isOwner()
    ? `<button class="button" type="button" data-action="create-announcement">${icon('plus')}新建公告</button>`
    : '';
  return `${pageHeader('公告', application.name, createButton)}
    <div class="toolbar section-header"><div class="inline-actions">${appSelector}</div></div>
    ${announcements.length
      ? `<div class="announcement-list">${announcements.map(announcementCard).join('')}</div>`
      : emptyState('megaphone', '暂无公告', '创建并发布后，公告会经程序私钥签名下发至客户端。', createButton)}`;
}
