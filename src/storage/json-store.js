import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { assertStateShape, createInitialState, upgradeState } from './schema.js';
import { StateStore } from './store.js';

function clone(value) {
  return structuredClone(value);
}

async function removeIfPresent(filePath) {
  try {
    await unlink(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}

export class JsonStore extends StateStore {
  #state = null;
  #writeQueue = Promise.resolve();

  constructor(filePath) {
    super();
    this.filePath = filePath;
  }

  async initialize() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const rawData = await readFile(this.filePath, 'utf8');
      const upgraded = upgradeState(JSON.parse(rawData));
      this.#state = upgraded.state;
      assertStateShape(this.#state);
      if (upgraded.changed) {
        await this.#persist(this.#state);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      this.#state = createInitialState();
      await this.#persist(this.#state);
    }
    return this;
  }

  async read(selector = (state) => state) {
    if (!this.#state) {
      throw new Error('JsonStore has not been initialized.');
    }
    return clone(await selector(clone(this.#state)));
  }

  async transaction(mutator) {
    const operation = this.#writeQueue.then(async () => {
      const draft = clone(this.#state);
      const result = await mutator(draft);
      draft.meta.updatedAt = new Date().toISOString();
      assertStateShape(draft);
      await this.#persist(draft);
      this.#state = draft;
      return clone(result);
    });

    this.#writeQueue = operation.catch(() => undefined);
    return operation;
  }

  async close() {}

  async #persist(state) {
    const suffix = `${process.pid}-${randomBytes(4).toString('hex')}`;
    const temporaryFile = `${this.filePath}.${suffix}.tmp`;
    const backupFile = `${this.filePath}.bak`;
    const serialized = `${JSON.stringify(state, null, 2)}\n`;
    await writeFile(temporaryFile, serialized, { encoding: 'utf8', flag: 'wx' });

    try {
      await rename(temporaryFile, this.filePath);
      return;
    } catch (error) {
      if (!['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) {
        await removeIfPresent(temporaryFile);
        throw error;
      }
    }

    await removeIfPresent(backupFile);
    await rename(this.filePath, backupFile);
    try {
      await rename(temporaryFile, this.filePath);
      await removeIfPresent(backupFile);
    } catch (error) {
      await removeIfPresent(this.filePath);
      await rename(backupFile, this.filePath);
      await removeIfPresent(temporaryFile);
      throw error;
    }
  }
}
