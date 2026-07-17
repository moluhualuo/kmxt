// Author: 花落. Distributed under the MIT License.
export class StateStore {
  async initialize() { return this; }

  async read(_selector) {
    throw new Error('StateStore.read must be implemented');
  }

  async transaction(_mutator) {
    throw new Error('StateStore.transaction must be implemented');
  }

  async ping() {
    await this.read(() => true);
    return true;
  }

  async close() {}
}

export function assertStoreContract(store) {
  for (const method of ['initialize', 'read', 'transaction', 'close']) {
    if (typeof store?.[method] !== 'function') {
      throw new TypeError(`Storage adapter must implement ${method}()`);
    }
  }
  return store;
}
