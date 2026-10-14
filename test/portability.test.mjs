import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
test('release sources contain no personal path or custom lazy-plugin dependency', async () => {
  const files = ['index.mjs', 'client.js', 'cordis.patch.yml', 'package.json', 'README.md'];
  for (const directory of ['src', 'scripts']) {
    for (const name of await fs.readdir(path.join(root, directory))) if (name.endsWith('.mjs')) files.push(`${directory}/${name}`);
  }
  for (const file of files) {
    const content = await fs.readFile(path.join(root, file), 'utf8');
    assert.equal(/\/Users\/|[A-Z]:\\Users\\|@local\/mcp-lazy-tools|\.npm\/_npx|\.pi\/agent/.test(content), false, file);
  }
  const patch = await fs.readFile(path.join(root, 'cordis.patch.yml'), 'utf8');
  assert.equal(/cwd\s*:/.test(patch), false);
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest.dependencies), ['qrcode']);
});
