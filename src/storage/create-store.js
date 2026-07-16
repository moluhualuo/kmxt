import { JsonStore } from './json-store.js';
import { MysqlStore } from './mysql-store.js';
import { assertStoreContract } from './store.js';

// Author: 花落. Storage selection is modular and MIT licensed.
export async function createStore(config) {
  const store = config.storageDriver === 'mysql'
    ? new MysqlStore(config)
    : new JsonStore(config.dataFile);
  assertStoreContract(store);
  return store.initialize();
}
