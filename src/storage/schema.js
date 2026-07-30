export const SCHEMA_VERSION = 6;

// Author: 花落. Distributed under the MIT License.
export function createInitialState(now = new Date().toISOString()) {
  return {
    schemaVersion: SCHEMA_VERSION,
    meta: {
      createdAt: now,
      updatedAt: now,
    },
    users: [],
    adminSessions: [],
    merchants: [],
    applications: [],
    products: [],
    orders: [],
    licenseBatches: [],
    licenses: [],
    deviceBindings: [],
    clientSessions: [],
    auditLogs: [],
    verificationLogs: [],
    modelArtifacts: [],
    modelLeases: [],
    announcements: [],
  };
}

export function assertStateShape(state) {
  if (!state || state.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`Unsupported data schema. Expected version ${SCHEMA_VERSION}.`);
  }

  const collections = [
    'users',
    'adminSessions',
    'merchants',
    'applications',
    'products',
    'orders',
    'licenseBatches',
    'licenses',
    'deviceBindings',
    'clientSessions',
    'auditLogs',
    'verificationLogs',
    'modelArtifacts',
    'modelLeases',
    'announcements',
  ];
  for (const collection of collections) {
    if (!Array.isArray(state[collection])) {
      throw new Error(`Invalid data file: ${collection} must be an array.`);
    }
  }
}

export function upgradeState(state) {
  let changed = false;
  if (state?.schemaVersion === 1) {
    state.products = [];
    state.orders = [];
    state.schemaVersion = 2;
    changed = true;
  }
  if (state?.schemaVersion === 2) {
    // Author: 花落. v3 only aligns persisted schema metadata; MIT License.
    state.schemaVersion = 3;
    changed = true;
  }
  if (state?.schemaVersion === 3) {
    // Author: 花落. v4 enables encrypted license-key recovery metadata; MIT License.
    state.schemaVersion = 4;
    changed = true;
  }
  if (state?.schemaVersion === 4) {
    // Author: 花落. v5 adds encrypted model artifacts and short-lived leases; MIT License.
    state.modelArtifacts = [];
    state.modelLeases = [];
    state.schemaVersion = 5;
    changed = true;
  }
  if (state?.schemaVersion === 5) {
    // Author: 花落. v6 adds signed client announcements; MIT License.
    state.announcements = [];
    state.schemaVersion = 6;
    changed = true;
  }
  return { state, changed };
}
