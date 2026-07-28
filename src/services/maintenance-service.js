import { requireInteger } from '../core/validation.js';
import { AuditService } from './audit-service.js';

// Author: 花落. Maintenance operations are provided under the MIT License.
export class MaintenanceService {
  constructor(store) { this.store = store; }

  async cleanupSessions(now = Date.now()) {
    if (this.store.repositories?.maintenance) {
      return this.store.repositories.maintenance.cleanupSessions(now);
    }
    return this.store.transaction((state) => {
      const adminBefore = state.adminSessions.length;
      const clientBefore = state.clientSessions.length;
      const leaseBefore = state.modelLeases.length;
      state.adminSessions = state.adminSessions.filter((item) => Date.parse(item.expiresAt) > now);
      state.clientSessions = state.clientSessions.filter((item) => Date.parse(item.expiresAt) > now);
      // Author: 花落. Expired active or revoked leases are removed under the MIT License.
      state.modelLeases = state.modelLeases.filter((item) => Date.parse(item.expiresAt) > now);
      const summary = {
        expiredAdminSessions: adminBefore - state.adminSessions.length,
        expiredClientSessions: clientBefore - state.clientSessions.length,
        expiredModelLeases: leaseBefore - state.modelLeases.length,
      };
      AuditService.append(state, { action: 'maintenance.sessions.cleanup', resourceType: 'maintenance', metadata: summary });
      return summary;
    });
  }

  async cleanupVerificationLogs(retentionDays, now = Date.now()) {
    const days = requireInteger(retentionDays, 'retentionDays', { min: 1, max: 3650 });
    const cutoff = now - days * 86400000;
    if (this.store.repositories?.maintenance) {
      return this.store.repositories.maintenance.cleanupVerificationLogs(days, cutoff);
    }
    return this.store.transaction((state) => {
      const before = state.verificationLogs.length;
      state.verificationLogs = state.verificationLogs.filter((item) => Date.parse(item.createdAt) >= cutoff);
      const summary = { deletedVerificationLogs: before - state.verificationLogs.length, retentionDays: days, cutoff: new Date(cutoff).toISOString() };
      AuditService.append(state, { action: 'maintenance.verification_logs.cleanup', resourceType: 'maintenance', metadata: summary });
      return summary;
    });
  }
}
