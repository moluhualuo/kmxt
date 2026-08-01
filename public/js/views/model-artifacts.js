import {
  api,
  emptyState,
  escapeHtml,
  formatDate,
  icon,
  isOwner,
  pageHeader,
  statusBadge,
  store,
} from './shared.js';

const STATUS_LABELS = Object.freeze({
  draft: '草稿',
  active: '已启用',
  revoked: '已吊销',
});

const FORMAT_LABELS = Object.freeze({
  onnx: 'ONNX',
  'ncnn-param': 'NCNN .param',
  'ncnn-bin': 'NCNN .bin',
  tflite: 'TensorFlow Lite',
  dlc: 'DLC',
  bundle: '文件包',
  so: 'Native .so',
  dex: 'DEX',
});

function formatArtifactSize(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let size = bytes / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size >= 10 ? size.toFixed(1) : size.toFixed(2)} ${units[unitIndex]}`;
}

function renderStatusActions(artifact) {
  if (!isOwner()) return '-';

  const actions = [];

  // 状态切换按钮
  if (artifact.status === 'draft') {
    actions.push(['active', '启用制品', 'circle-check', '']);
    actions.push(['revoked', '吊销制品', 'ban', 'danger']);
  } else if (artifact.status === 'active') {
    actions.push(['draft', '退回草稿', 'refresh-cw', '']);
    actions.push(['revoked', '吊销制品', 'ban', 'danger']);
  }

  // 删除按钮（草稿和已吊销可删除）
  if (artifact.status === 'draft' || artifact.status === 'revoked') {
    actions.push(['delete', '删除制品', 'trash-2', 'danger']);
  }

  if (actions.length === 0) return '-';

  return `<div class="inline-actions">${actions.map(([action, label, iconName, style]) => {
    const dataAction = action === 'delete' ? 'delete-model-artifact' : 'set-model-artifact-status';
    const dataStatus = action === 'delete' ? '' : `data-status="${action}"`;
    return `<button class="icon-button ${style}" type="button" data-action="${dataAction}" data-id="${escapeHtml(artifact.id)}" ${dataStatus} aria-label="${label}" title="${label}">${icon(iconName)}</button>`;
  }).join('')}</div>`;
}

// Author: 花落. Encrypted model-artifact administration is modular and MIT licensed.
export async function renderModelArtifactsView() {
  const application = store.application;
  const appSelector = `<select class="select" id="model-artifact-app-context" aria-label="当前程序">
    ${store.value.applications.length
      ? store.value.applications.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === store.value.selectedAppId ? 'selected' : ''}>${escapeHtml(item.name)} · ${escapeHtml(item.code)}</option>`).join('')
      : '<option value="">暂无程序</option>'}
  </select>`;

  if (!application) {
    const createButton = isOwner()
      ? `<button class="button" type="button" data-action="create-app">${icon('plus')}新建程序</button>`
      : '';
    return `${pageHeader('加密模型', '加密制品与发布状态')}${emptyState('boxes', '暂无程序', '请先创建或选择程序。', createButton)}`;
  }

  const result = await api.get(`/api/v1/apps/${encodeURIComponent(application.id)}/artifacts`);
  const artifacts = Array.isArray(result) ? result : [];
  store.patch({ modelArtifacts: artifacts });
  const owner = isOwner();
  const selectedStatus = ['draft', 'active', 'revoked'].includes(store.value.modelArtifactStatus)
    ? store.value.modelArtifactStatus
    : '';
  const visibleArtifacts = selectedStatus
    ? artifacts.filter((artifact) => artifact.status === selectedStatus)
    : artifacts;
  // 所有可见制品都可勾选，多选集合仅在当前可见的制品间保留；各批量操作再按状态各自过滤
  const visibleIds = new Set(visibleArtifacts.map((artifact) => artifact.id));
  const selectedIds = new Set((store.value.selectedArtifactIds || []).filter((id) => visibleIds.has(id)));
  const selectedCount = selectedIds.size;
  const selectedArtifacts = visibleArtifacts.filter((artifact) => selectedIds.has(artifact.id));
  // 各批量操作可作用的选中数量：启用只对草稿，吊销对草稿/已启用，删除对草稿/已吊销
  const selectedActivatable = selectedArtifacts.filter((artifact) => artifact.status === 'draft').length;
  const selectedRevocable = selectedArtifacts.filter((artifact) => artifact.status === 'draft' || artifact.status === 'active').length;
  const selectedDeletable = selectedArtifacts.filter((artifact) => artifact.status === 'draft' || artifact.status === 'revoked').length;
  const totals = artifacts.reduce((summary, artifact) => {
    if (Object.hasOwn(summary, artifact.status)) summary[artifact.status] += 1;
    return summary;
  }, { draft: 0, active: 0, revoked: 0 });

  const metrics = [
    ['制品总数', artifacts.length, 'boxes', ''],
    ['草稿', totals.draft, 'refresh-cw', 'info'],
    ['已启用', totals.active, 'circle-check', ''],
    ['已吊销', totals.revoked, 'ban', 'info'],
  ].map(([label, value, iconName, tone]) => `<article class="metric-card"><div><small>${label}</small><div class="metric-value">${value}</div></div><span class="metric-icon ${tone}">${icon(iconName)}</span></article>`).join('');

  const rows = visibleArtifacts.map((artifact) => {
    const cipherSha256 = String(artifact.cipherSha256 || '-');
    const sha256Short = cipherSha256.length >= 16 ? `${cipherSha256.slice(0, 8)}...${cipherSha256.slice(-8)}` : cipherSha256;
    const selectCell = owner
      ? `<td><input type="checkbox" data-artifact-select value="${escapeHtml(artifact.id)}" data-status="${escapeHtml(artifact.status)}" data-name="${escapeHtml(String(artifact.name || ''))}" data-version="${escapeHtml(String(artifact.version || ''))}" ${selectedIds.has(artifact.id) ? 'checked' : ''} aria-label="选择制品 ${escapeHtml(artifact.name)}"></td>`
      : '';
    return `<tr>
      ${selectCell}
      <td><span class="cell-primary">${escapeHtml(artifact.name)}</span><button class="cell-secondary mono uuid-copy" type="button" data-action="copy-model-artifact-id" data-value="${escapeHtml(String(artifact.id || ''))}" data-name="${escapeHtml(String(artifact.name || ''))}" data-version="${escapeHtml(String(artifact.version || ''))}" title="点击复制模型名 + 版本 + UUID" aria-label="复制制品 UUID 与模型信息">${escapeHtml(String(artifact.id || '-'))} ${icon('copy')}</button></td>
      <td class="mono">${escapeHtml(artifact.version)}</td>
      <td>${escapeHtml(artifact.edition || '-')}</td>
      <td><span class="cell-primary">${escapeHtml(FORMAT_LABELS[artifact.format] || artifact.format || '-')}</span><span class="cell-secondary">${escapeHtml(artifact.encryption?.algorithm || '-')} · K${escapeHtml(artifact.keyVersion || 1)}</span></td>
      <td class="mono">${escapeHtml(formatArtifactSize(artifact.size))}</td>
      <td><span class="cell-primary mono" title="密文指纹：${escapeHtml(cipherSha256)}" aria-label="SHA-256 ${escapeHtml(cipherSha256)}">${escapeHtml(sha256Short)}</span></td>
      <td>${statusBadge(artifact.status, STATUS_LABELS[artifact.status] || artifact.status)}</td>
      <td>${formatDate(artifact.updatedAt)}</td>
      <td>${renderStatusActions(artifact)}</td>
    </tr>`;
  }).join('');

  // 批量操作：导出 JSON 对任意选中生效；启用/吊销/删除各自按可作用数量启用按钮
  const bulkActions = owner
    ? `<button class="button secondary" type="button" data-action="bulk-export-model-artifacts" ${selectedCount > 0 ? '' : 'disabled'}>${icon('download')}导出 JSON${selectedCount > 0 ? `（${selectedCount}）` : ''}</button>
       <button class="button" type="button" data-action="bulk-activate-model-artifacts" ${selectedActivatable > 0 ? '' : 'disabled'}>${icon('circle-check')}批量启用${selectedActivatable > 0 ? `（${selectedActivatable}）` : ''}</button>
       <button class="button danger" type="button" data-action="bulk-revoke-model-artifacts" ${selectedRevocable > 0 ? '' : 'disabled'}>${icon('ban')}批量吊销${selectedRevocable > 0 ? `（${selectedRevocable}）` : ''}</button>
       <button class="button danger" type="button" data-action="bulk-delete-model-artifacts" ${selectedDeletable > 0 ? '' : 'disabled'}>${icon('trash-2')}批量删除${selectedDeletable > 0 ? `（${selectedDeletable}）` : ''}</button>`
    : '';
  const registerButton = isOwner()
    ? `<button class="button" type="button" data-action="upload-model-artifact">${icon('upload')}上传加密</button>`
    : '';
  const headerActions = owner
    ? `<div class="inline-actions">${bulkActions}${registerButton}</div>`
    : registerButton;
  const noRowsMessage = artifacts.length
    ? '当前状态筛选下没有制品。'
    : '当前程序还没有登记加密模型制品。';
  // 表头全选：勾选/取消当前可见的全部制品
  const headerCheckbox = owner
    ? `<th><input type="checkbox" id="model-artifact-select-all" ${visibleIds.size && selectedCount === visibleIds.size ? 'checked' : ''} ${visibleIds.size ? '' : 'disabled'} aria-label="选择当前可见的全部制品"></th>`
    : '';
  const rowHeader = `${headerCheckbox}<th>制品</th><th>版本</th><th>版本类型</th><th>格式 / 加密</th><th>密文大小</th><th>密文指纹</th><th>状态</th><th>更新时间</th><th>操作</th>`;

  return `${pageHeader('加密模型', application.name, headerActions)}
    <section class="metrics-grid" aria-label="模型制品指标">${metrics}</section>
    <div class="toolbar section-header">
      <div class="inline-actions">${appSelector}
        <select class="select" id="model-artifact-status-filter" aria-label="制品状态">
          <option value="">全部状态</option>
          ${Object.entries(STATUS_LABELS).map(([status, label]) => `<option value="${status}" ${selectedStatus === status ? 'selected' : ''}>${label}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="table-frame">
      ${rows.length > 0 ? `<div class="table-scroll"><table class="model-artifacts-table"><thead><tr>${rowHeader}</tr></thead><tbody>${rows}</tbody></table></div>` : emptyState('boxes', '暂无模型制品', noRowsMessage, artifacts.length ? '' : registerButton)}
    </div>`;
}
