import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = await mkdtemp(path.join(tmpdir(), 'dsh-wechat-package-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
function command(executable, args, cwd) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', timeout: 60000,
    shell: process.platform === 'win32' && executable.endsWith('.cmd') });
  if (result.status !== 0) throw new Error(`${executable}: ${result.stderr || result.error}`);
  return result.stdout;
}
try {
  const [packed] = JSON.parse(command(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], root));
  const paths = packed.files.map(file => file.path);
  for (const required of ['index.mjs', 'client.js', 'src/ownership.mjs', 'src/bridge.mjs', 'cordis.patch.yml', 'LICENSE', 'README.md', 'locale/en.json', 'scripts/recover.mjs', 'docs/verification.md']) {
    assert.ok(paths.includes(required), required);
  }
  for (const entry of paths) {
    assert.doesNotMatch(entry, /(^|\/)(node_modules|dist|test|\.git|\.env|store\.json|store\.lock)/);
  }
  command('tar', ['-xzf', path.join(temporary, packed.filename), '-C', temporary], root);
  const unpacked = path.join(temporary, 'package');
  const manifest = JSON.parse(await readFile(path.join(unpacked, 'package.json'), 'utf8'));
  assert.equal(manifest.name, '@satanfire/dsh-wechat');
  const entry = await import(pathToFileURL(path.join(unpacked, manifest.exports['.'])).href);
  assert.equal(typeof entry.apply, 'function');
  for (const module of await readdir(path.join(unpacked, 'src'))) {
    if (module.endsWith('.mjs')) await import(pathToFileURL(path.join(unpacked, 'src', module)).href);
  }
  console.log(`Verified real tarball: ${paths.length} files, ${packed.size} compressed bytes; portable Host imports passed.`);
} finally {
  const resolved = path.resolve(temporary);
  assert.equal(path.dirname(resolved), path.resolve(tmpdir()));
  assert.ok(path.basename(resolved).startsWith('dsh-wechat-package-'));
  await rm(resolved, { recursive: true, force: true });
}
