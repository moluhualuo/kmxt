const STATUS_LABELS = Object.freeze({
  active: '启用',
  pending: '未激活',
  disabled: '已禁用',
  expired: '已到期',
  revoked: '已解绑',
  fulfilled: '已发卡',
  rejected: '已拒绝',
});

const ROLE_LABELS = Object.freeze({
  platform_admin: '平台管理员',
  merchant_admin: '商户管理员',
  operator: '操作员',
});

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function icon(name, className = 'icon') {
  const safeName = /^[a-z0-9-]+$/.test(name) ? name : 'alert-triangle';
  const safeClass = /^[a-z0-9 _-]+$/i.test(className) ? className : 'icon';
  return `<svg class="${safeClass}" aria-hidden="true"><use href="/admin/assets/icons.svg#${safeName}"></use></svg>`;
}

export function formatDate(value, options = {}) {
  if (!value) {
    return '-';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '-';
  }
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(options.dateOnly ? {} : { hour: '2-digit', minute: '2-digit' }),
    hour12: false,
  }).format(date);
}

export function statusBadge(status, label = null) {
  return `<span class="badge ${escapeHtml(status)}">${escapeHtml(label || STATUS_LABELS[status] || status)}</span>`;
}

export function roleLabel(role) {
  return ROLE_LABELS[role] || role;
}

export function emptyState(iconName, title, message, actionHtml = '') {
  return `<div class="empty-state">
    <div class="empty-state-icon">${icon(iconName)}</div>
    <div class="empty-state-copy">
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(message)}</p>
    </div>
    ${actionHtml ? `<div class="empty-state-action">${actionHtml}</div>` : ''}
  </div>`;
}

export function pagination(data, actionPrefix) {
  const from = data.total === 0 ? 0 : (data.page - 1) * data.limit + 1;
  const to = Math.min(data.page * data.limit, data.total);
  const hasPrevious = data.page > 1;
  const hasNext = data.page * data.limit < data.total;
  return `<div class="pagination">
    <span class="pagination-summary">显示 ${from}-${to} 条，共 ${data.total} 条</span>
    <div class="inline-actions">
      <button class="icon-button" type="button" data-action="${actionPrefix}-previous" ${hasPrevious ? '' : 'disabled'} aria-label="上一页" title="上一页">${icon('chevron-left')}</button>
      <button class="icon-button" type="button" data-action="${actionPrefix}-next" ${hasNext ? '' : 'disabled'} aria-label="下一页" title="下一页">${icon('chevron-right')}</button>
    </div>
  </div>`;
}

export function showToast(message, type = 'success') {
  const region = document.querySelector('#toast-region');
  const toast = document.createElement('div');
  toast.className = `toast ${type === 'error' ? 'error' : ''}`;
  toast.innerHTML = `${icon(type === 'error' ? 'alert-triangle' : 'circle-check')}<span>${escapeHtml(message)}</span>`;
  region.append(toast);
  window.setTimeout(() => toast.remove(), 4200);
}

function dialogTemplate(options, includeForm) {
  const formStart = includeForm ? '<form method="dialog" class="dialog-form">' : '';
  const formEnd = includeForm ? '</form>' : '';
  const footer = includeForm
    ? `<footer class="dialog-footer">
        <button class="button secondary" type="button" data-dialog-close>取消</button>
        <button class="button" type="submit" data-dialog-submit>${escapeHtml(options.submitLabel || '保存')}</button>
      </footer>`
    : `<footer class="dialog-footer">
        ${options.footer || ''}
        <button class="button secondary" type="button" data-dialog-close>关闭</button>
      </footer>`;
  return `${formStart}
    <header class="dialog-header">
      <h2>${escapeHtml(options.title)}</h2>
      <button class="icon-button" type="button" data-dialog-close aria-label="关闭" title="关闭">${icon('x')}</button>
    </header>
    <div class="dialog-body">
      ${options.content}
      ${includeForm ? '<div class="form-error" role="alert"></div>' : ''}
    </div>
    ${footer}
  ${formEnd}`;
}

function mountDialog(options, includeForm) {
  const dialog = document.createElement('dialog');
  if (options.wide) {
    dialog.classList.add('wide');
  }
  dialog.innerHTML = dialogTemplate(options, includeForm);
  document.body.append(dialog);
  const close = () => dialog.close();
  dialog.querySelectorAll('[data-dialog-close]').forEach((button) => button.addEventListener('click', close));
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) {
      const bounds = dialog.getBoundingClientRect();
      const inside = event.clientX >= bounds.left && event.clientX <= bounds.right
        && event.clientY >= bounds.top && event.clientY <= bounds.bottom;
      if (!inside) {
        close();
      }
    }
  });
  dialog.showModal();
  options.onOpen?.(dialog);
  return dialog;
}

export function openFormDialog(options) {
  const dialog = mountDialog(options, true);
  const form = dialog.querySelector('form');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submitButton = dialog.querySelector('[data-dialog-submit]');
    const errorBox = dialog.querySelector('.form-error');
    submitButton.disabled = true;
    submitButton.innerHTML = `<span class="button-spinner" aria-hidden="true"></span><span>处理中</span>`;
    errorBox.classList.remove('visible');
    try {
      const shouldClose = await options.onSubmit(new FormData(form), dialog);
      if (shouldClose !== false) {
        dialog.close();
      }
    } catch (error) {
      errorBox.textContent = error.message || '操作失败。';
      errorBox.classList.add('visible');
    } finally {
      if (dialog.open) {
        submitButton.disabled = false;
        submitButton.textContent = options.submitLabel || '保存';
      }
    }
  });
  return dialog;
}

export function openContentDialog(options) {
  return mountDialog(options, false);
}

export function confirmAction(options) {
  return new Promise((resolve) => {
    let resolved = false;
    const dialog = openFormDialog({
      title: options.title,
      content: `<div class="form-stack"><p>${escapeHtml(options.message)}</p></div>`,
      submitLabel: options.confirmLabel || '确认',
      onSubmit: async () => {
        resolved = true;
        resolve(true);
      },
    });
    dialog.addEventListener('close', () => {
      if (!resolved) {
        resolve(false);
      }
    }, { once: true });
  });
}

export function downloadText(filename, content, type = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
