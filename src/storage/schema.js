export const SCHEMA_VERSION = 2;

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
  return { state, changed };
}
