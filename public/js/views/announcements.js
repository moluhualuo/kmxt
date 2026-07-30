import { api } from '../api.js';
import {
  confirmAction,
  emptyState,
  escapeHtml,
  formatDate,
  icon,
  openFormDialog,
  showToast,
  statusBadge,
} from '../components.js';
import { store } from '../state.js';

// 作者：花落｜MIT
export async function renderAnnouncementsView() {
  const appId = store.value.selectedAppId;
  if (!appId) {
    return `<main class="view-content empty-selection" id="main-content">
      ${emptyState(icon('megaphone'), '请先选择一个程序')}
    </main>`;
  }

  const announcements = await api.get(`/api/v1/apps/${encodeURIComponent(appId)}/announcements`);

  return `<main class="view-content" id="main-content">
    <header class="view-header">
      <div class="view-title-row">
        <h1>公告</h1>
        <button class="button primary" data-action="create-announcement" aria-label="创建公告">
          ${icon('plus')}创建公告
        </button>
      </div>
      <p class="view-subtitle">创建并下发客户端公告，程序私钥签名后自动携带在验证响应中。</p>
    </header>
    ${announcements.length === 0
      ? `<div class="view-body">${emptyState(icon('megaphone'), '还没有公告', '创建第一条公告后，将通过 Ed25519 签名信封下发至客户端。')}</div>`
      : `<div class="view-body">
          <div class="announcement-list">${announcements.map(renderAnnouncementCard).join('')}</div>
        </div>`
    }
  </main>`;
}

function renderAnnouncementCard(announcement) {
  const severityClass = {
    info: 'info',
    warning: 'warning',
    critical: 'critical',
  }[announcement.severity] || 'info';

  const isDraft = announcement.status === 'draft';
  const isPublished = announcement.status === 'published';
  const withinWindow = isWithinTimeWindow(announcement);

  let statusDisplay;
  if (isDraft) {
    statusDisplay = `<span class="announcement-status draft">${icon('edit-3')}草稿</span>`;
  } else if (!withinWindow) {
    statusDisplay = `<span class="announcement-status inactive">${icon('clock')}已过期</span>`;
  } else {
    statusDisplay = `<span class="announcement-status active">${icon('check-circle')}已发布</span>`;
  }

  return `<article class="announcement-card severity-${severityClass}">
    <div class="announcement-header">
      <div class="announcement-meta">
        <span class="announcement-sequence">#${announcement.sequence}</span>
        <span class="announcement-severity ${severityClass}">${severityLabel(announcement.severity)}</span>
        ${statusDisplay}
      </div>
      <div class="announcement-actions">
        <button class="icon-button" data-action="edit-announcement" data-id="${announcement.id}" aria-label="编辑">
          ${icon('edit-2')}
        </button>
        <button class="icon-button" data-action="delete-announcement" data-id="${announcement.id}" aria-label="删除">
          ${icon('trash-2')}
        </button>
      </div>
    </div>
    <h3 class="announcement-title">${escapeHtml(announcement.title)}</h3>
    <p class="announcement-body">${escapeHtml(announcement.body).replace(/\n/g, '<br>')}</p>
    <div class="announcement-footer">
      ${announcement.startsAt ? `<span>${icon('calendar')}${formatDate(announcement.startsAt)}</span>` : ''}
      ${announcement.endsAt ? `<span>${icon('calendar')}至 ${formatDate(announcement.endsAt)}</span>` : ''}
      <span>${icon('clock')}创建于 ${formatDate(announcement.createdAt)}</span>
    </div>
    ${isDraft ? `<div class="announcement-publish-row">
      <button class="button small primary" data-action="publish-announcement" data-id="${announcement.id}">
        ${icon('send')}发布
      </button>
    </div>` : ''}
  </article>`;
}

function isWithinTimeWindow(announcement) {
  if (announcement.status !== 'published') return false;
  const now = Date.now();
  if (announcement.startsAt && Date.parse(announcement.startsAt) > now) return false;
  if (announcement.endsAt && Date.parse(announcement.endsAt) <= now) return false;
  return true;
}

function severityLabel(severity) {
  const labels = { info: '提示', warning: '警告', critical: '重要' };
  return labels[severity] || severity;
}

// ========== EVENT_MARKER_A ==========

store.on('viewMounted:announcements', () => {
  document.querySelectorAll('[data-action="create-announcement"]').forEach((button) => {
    button.addEventListener('click', () => openAnnouncementForm());
  });
  document.querySelectorAll('[data-action="edit-announcement"]').forEach((button) => {
    button.addEventListener('click', async (event) => {
      const announcementId = event.currentTarget.dataset.id;
      const appId = store.value.selectedAppId;
      const announcements = await api.get(`/api/v1/apps/${encodeURIComponent(appId)}/announcements`);
      const announcement = announcements.find((item) => item.id === announcementId);
      if (announcement) {
        openAnnouncementForm(announcement);
      }
    });
  });
  document.querySelectorAll('[data-action="publish-announcement"]').forEach((button) => {
    button.addEventListener('click', async (event) => {
      const announcementId = event.currentTarget.dataset.id;
      try {
        await api.patch(`/api/v1/announcements/${encodeURIComponent(announcementId)}/status`, { status: 'published' });
        showToast('公告已发布');
        store.emit('navigate', 'announcements');
      } catch (error) {
        showToast('发布失败：' + error.message, 'error');
      }
    });
  });
  document.querySelectorAll('[data-action="delete-announcement"]').forEach((button) => {
    button.addEventListener('click', async (event) => {
      const announcementId = event.currentTarget.dataset.id;
      const confirmed = await confirmAction('确认删除此公告？', '删除后客户端将不再收到此公告。');
      if (!confirmed) return;
      try {
        await api.delete(`/api/v1/announcements/${encodeURIComponent(announcementId)}`);
        showToast('公告已删除');
        store.emit('navigate', 'announcements');
      } catch (error) {
        showToast('删除失败：' + error.message, 'error');
      }
    });
  });
});

function openAnnouncementForm(existingAnnouncement = null) {
  const isEdit = !!existingAnnouncement;
  const fields = [
    { name: 'title', label: '标题', type: 'text', required: true, value: existingAnnouncement?.title || '', maxlength: 100 },
    { name: 'body', label: '内容', type: 'textarea', required: true, value: existingAnnouncement?.body || '', maxlength: 2000, rows: 6 },
    {
      name: 'severity',
      label: '级别',
      type: 'select',
      required: true,
      value: existingAnnouncement?.severity || 'info',
      options: [
        { value: 'info', label: '提示' },
        { value: 'warning', label: '警告' },
        { value: 'critical', label: '重要' },
      ],
    },
    { name: 'startsAt', label: '开始时间（可选）', type: 'datetime-local', value: existingAnnouncement?.startsAt ? toLocalDatetimeValue(existingAnnouncement.startsAt) : '' },
    { name: 'endsAt', label: '结束时间（可选）', type: 'datetime-local', value: existingAnnouncement?.endsAt ? toLocalDatetimeValue(existingAnnouncement.endsAt) : '' },
  ];

  openFormDialog({
    title: isEdit ? '编辑公告' : '创建公告',
    fields,
    submitLabel: isEdit ? '保存' : '创建',
    onSubmit: async (formData) => {
      const payload = {
        title: formData.get('title'),
        body: formData.get('body'),
        severity: formData.get('severity'),
        startsAt: formData.get('startsAt') ? new Date(formData.get('startsAt')).toISOString() : null,
        endsAt: formData.get('endsAt') ? new Date(formData.get('endsAt')).toISOString() : null,
      };
      if (isEdit) {
        await api.patch(`/api/v1/announcements/${encodeURIComponent(existingAnnouncement.id)}`, payload);
        showToast('公告已更新');
      } else {
        const appId = store.value.selectedAppId;
        await api.post(`/api/v1/apps/${encodeURIComponent(appId)}/announcements`, payload);
        showToast('公告已创建');
      }
      store.emit('navigate', 'announcements');
    },
  });
}

function toLocalDatetimeValue(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

