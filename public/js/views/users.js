import { api, emptyState, escapeHtml, formatDate, icon, pageHeader, roleLabel, statusBadge, store } from './shared.js';

// Author: 花落. Merchant account view rendering is modular and MIT licensed.
export async function renderUsersView() {
  const merchant = store.merchant;
  if (!merchant) {
    return `${pageHeader('账号', '商户账号与角色')}${emptyState('users', '未选择商户', '请先创建或选择商户。')}`;
  }
  const users = await api.get(`/api/v1/merchants/${encodeURIComponent(merchant.id)}/users`);
  const rows = users.map((user) => `<tr>
    <td><span class="cell-primary">${escapeHtml(user.displayName)}</span><span class="cell-secondary mono">${escapeHtml(user.id.slice(0, 8))}</span></td>
    <td>${escapeHtml(user.username)}</td>
    <td>${escapeHtml(roleLabel(user.role))}</td>
    <td>${statusBadge(user.status)}</td>
    <td>${formatDate(user.lastLoginAt)}</td>
    <td>${formatDate(user.createdAt)}</td>
    <td>${user.id === store.value.user.id ? '<span class="cell-secondary">当前账号</span>' : `<div class="inline-actions"><button class="icon-button" type="button" data-action="change-user-role" data-id="${escapeHtml(user.id)}" data-role="${escapeHtml(user.role)}" data-username="${escapeHtml(user.username)}" aria-label="修改 ${escapeHtml(user.username)} 的角色" title="修改角色">${icon('shield-check')}</button><button class="icon-button" type="button" data-action="reset-user-password" data-id="${escapeHtml(user.id)}" data-username="${escapeHtml(user.username)}" aria-label="重置 ${escapeHtml(user.username)} 的密码" title="重置密码">${icon('key-round')}</button><button class="icon-button" type="button" data-action="toggle-user" data-id="${escapeHtml(user.id)}" data-status="${escapeHtml(user.status)}" data-username="${escapeHtml(user.username)}" aria-label="${user.status === 'active' ? '停用' : '启用'} ${escapeHtml(user.username)}" title="${user.status === 'active' ? '停用' : '启用'}账号">${icon(user.status === 'active' ? 'ban' : 'circle-check')}</button></div>`}</td>
  </tr>`).join('');
  return `${pageHeader('账号', merchant.name, `<button class="button" type="button" data-action="create-user">${icon('plus')}新建账号</button>`)}
    <div class="table-frame"><div class="table-scroll"><table><thead><tr><th>账号</th><th>用户名</th><th>角色</th><th>状态</th><th>最后登录</th><th>创建时间</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
}
