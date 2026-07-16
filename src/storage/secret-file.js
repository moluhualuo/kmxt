import { readFile } from 'node:fs/promises';

// Author: 花落. Secret material is file-only under the MIT-licensed implementation.
export async function readRequiredSecretFile(filePath, label) {
  if (!filePath) throw new Error(`${label} secret file is required`);
  const value = (await readFile(filePath, 'utf8')).trim();
  if (!value) throw new Error(`${label} secret file is empty`);
  return value;
}

export async function readRequiredTextFile(filePath, label) {
  if (!filePath) throw new Error(`${label} file is required`);
  const value = await readFile(filePath, 'utf8');
  if (!value.trim()) throw new Error(`${label} file is empty`);
  return value;
}
