import { readFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const json = async name => JSON.parse(await readFile(path.join(root, name), 'utf8'));
const manifest = await json('package.json');
const lock = await json('package-lock.json');
assert.equal(manifest.name, '@satanfire/dsh-wechat');
assert.equal(manifest.license, 'MIT');
assert.equal(manifest.private, undefined);
assert.equal(lock.name, manifest.name);
assert.equal(lock.version, manifest.version);
assert.equal(lock.packages[''].version, manifest.version);
assert.equal(manifest.exports['.'], './index.mjs');
assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
assert.equal(manifest.peerDependencies['@deepseek-ai/dsh'], '0.2.0-rc.2');
const client = await readFile(path.join(root, 'client.js'), 'utf8');
assert.ok(client.includes(`id: '${manifest.name}'`));
assert.ok((await readFile(path.join(root, 'cordis.patch.yml'), 'utf8')).includes("name: './index.mjs'"));
for (const name of ['LICENSE', 'README.md', 'README.en.md', 'NOTICE.md', 'SECURITY.md', 'locale/en.json', 'locale/zh.json']) {
  assert.ok((await stat(path.join(root, name))).isFile(), name);
}
for (const language of ['en', 'zh']) assert.ok((await json(`locale/${language}.json`)).meta.title);
const files = ['index.mjs', 'client.js'];
for (const folder of ['src', 'scripts', 'test']) {
  for (const name of await readdir(path.join(root, folder))) if (/\.(mjs|js)$/.test(name)) files.push(`${folder}/${name}`);
}
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, file)], { encoding: 'utf8', timeout: 10000 });
  if (result.status !== 0) throw new Error(`${file}: ${result.stderr || result.error}`);
}
console.log(`Checked manifest, metadata, lockfile, and syntax of ${files.length} modules.`);
