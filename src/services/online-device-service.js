import { optionalString, requireEnum } from '../core/validation.js';
import {
  assertMerchantAccess,
  findApplicationOrThrow,
  findBindingOrThrow,
} from './access-control.js';
import { AuditService } from './audit-service.js';

const DEVICE_STATUSES = ['all', 'online', 'offline'];

function onlineWindowSeconds(application, fallback) {
  const heartbeatSeconds = Number(application.settings?.heartbeatSeconds || fallback || 300);
  return Math.max(60, heartbeatSeconds * 2);
}

function latestSession(sessions, bindingId, nowMilliseconds) {
  return sessions
    .filter((session) => session.bindingId === bindingId && Date.parse(session.expiresAt) > nowMilliseconds)
    .sort((left, right) => Date.parse(right.lastVerifiedAt) - Date.parse(left.lastVerifiedAt))[0] || null;
}

function presentOnlineDevice(binding, license, session, cutoffMilliseconds) {
  const lastSeenAt = session?.lastVerifiedAt || binding.lastVerifiedAt || binding.boundAt;
  const online = Boolean(session && Date.parse(lastSeenAt) >= cutoffMilliseconds);
  return {
    bindingId: binding.id,
    licenseId: binding.licenseId,
    licenseKeyPreview: license?.keyPreview || null,
    deviceLabel: binding.deviceLabel || '未命名设备',
    clientVersion: session?.clientVersion || binding.lastClientVersion || null,
    ipAddress: session?.ipAddress || binding.lastIpAddress || null,
    online,
    status: online ? 'online' : 'offline',
    boundAt: binding.boundAt,
    lastSeenAt,
    sessionExpiresAt: session?.expiresAt || null,
  };
}

// Author: 花落. Online-device presence and disconnect controls are provided under the MIT License.
export class OnlineDeviceService {
  constructor(store, config) {
    this.store = store;
    this.config = config;
  }

  async list(actor, appId, pagination, rawFilters = {}) {
    const status = requireEnum(rawFilters.status || 'online', 'status', DEVICE_STATUSES);
    const search = optionalString(rawFilters.search, 'search', { min: 1, max: 100 })?.toLowerCase() || '';
    const nowMilliseconds = Date.now();

    if (this.store.repositories?.onlineDevices) {
      return this.store.repositories.onlineDevices.list(actor, appId, pagination, {
        status,
        search,
        nowMilliseconds,
        fallbackHeartbeatSeconds: this.config.heartbeatSeconds,
      });
    }

    return this.store.read((state) => {
      const application = findApplicationOrThrow(state, appId);
      assertMerchantAccess(actor, application.merchantId);
      const windowSeconds = onlineWindowSeconds(application, this.config.heartbeatSeconds);
      const cutoffMilliseconds = nowMilliseconds - windowSeconds * 1000;
      const licenses = new Map(state.licenses.map((license) => [license.id, license]));
      const allItems = state.deviceBindings
        .filter((binding) => binding.appId === appId && binding.status === 'active')
        .map((binding) => presentOnlineDevice(
          binding,
          licenses.get(binding.licenseId),
          latestSession(state.clientSessions, binding.id, nowMilliseconds),
          cutoffMilliseconds,
        ))
        .sort((left, right) => Number(right.online) - Number(left.online)
          || Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt));
      const summary = {
        total: allItems.length,
        online: allItems.filter((item) => item.online).length,
        offline: allItems.filter((item) => !item.online).length,
        onlineWindowSeconds: windowSeconds,
      };
      const filtered = allItems.filter((item) => {
        if (status !== 'all' && item.status !== status) return false;
        if (!search) return true;
        return [item.deviceLabel, item.licenseKeyPreview, item.clientVersion, item.ipAddress]
          .some((value) => String(value || '').toLowerCase().includes(search));
      });
      return {
        items: filtered.slice(pagination.offset, pagination.offset + pagination.limit),
        page: pagination.page,
        limit: pagination.limit,
        total: filtered.length,
        summary,
      };
    });
  }

  async disconnect(actor, bindingId) {
    if (this.store.repositories?.onlineDevices) {
      return this.store.repositories.onlineDevices.disconnect(actor, bindingId);
    }
    return this.store.transaction((state) => {
      const binding = findBindingOrThrow(state, bindingId);
      assertMerchantAccess(actor, binding.merchantId);
      const before = state.clientSessions.length;
      state.clientSessions = state.clientSessions.filter((session) => session.bindingId !== bindingId);
      const disconnectedSessions = before - state.clientSessions.length;
      if (disconnectedSessions > 0) {
        AuditService.append(state, {
          actor,
          merchantId: binding.merchantId,
          action: 'device.disconnect',
          resourceType: 'device_binding',
          resourceId: binding.id,
          metadata: { appId: binding.appId, licenseId: binding.licenseId, disconnectedSessions },
        });
      }
      return { bindingId, disconnectedSessions };
    });
  }
}

export { onlineWindowSeconds };
