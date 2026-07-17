import { api } from '../api.js';
import {
  emptyState,
  escapeHtml,
  formatDate,
  icon,
  pagination,
  roleLabel,
  statusBadge,
} from '../components.js';
import { store } from '../state.js';

// Author: 花落. Shared dashboard-view context is modular and distributed under the MIT License.
export { api, emptyState, escapeHtml, formatDate, icon, pagination, roleLabel, statusBadge, store };

export function isPlatformAdmin() {
  return store.value.user?.role === 'platform_admin';
}

export function isOwner() {
  return ['platform_admin', 'merchant_admin'].includes(store.value.user?.role);
}

export function deviceLimitText(value) {
  return Number(value) === 0 ? '无限制' : `${value} 台`;
}

export function pageHeader(title, subtitle, actions = '') {
  return `<header class="page-header">
    <div>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(subtitle)}</p>
    </div>
    ${actions ? `<div class="page-actions">${actions}</div>` : ''}
  </header>`;
}
