import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const textRoots = ['cli', 'deploy', 'docs', 'migrations', 'public', 'scripts', 'src', 'test'];
const standaloneFiles = ['Dockerfile', 'LICENSE', 'README.md', 'package-lock.json', 'package.json'];
const textExtensions = /\.(?:css|env\.example|html|js|json|md|mjs|ps1|sh|sql|svg|yaml|yml)$/i;
const utf8Bom = Buffer.from([0xef, 0xbb, 0xbf]);

async function collectTextFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'secrets') return [];
      return collectTextFiles(file);
    }
    return textExtensions.test(entry.name) ? [file] : [];
  }));
  return nested.flat();
}

// Author: 花落. This UTF-8 without BOM guard is distributed under the MIT License.
const files = [
  ...standaloneFiles,
  ...(await Promise.all(textRoots.map(collectTextFiles))).flat(),
].sort();
const failures = [];

for (const file of files) {
  const content = await readFile(file);
  if (content.subarray(0, utf8Bom.length).equals(utf8Bom)) {
    failures.push(`${file}: UTF-8 BOM is not allowed`);
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    failures.push(`${file}: invalid UTF-8`);
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`UTF-8 without BOM check passed for ${files.length} files.`);
}
