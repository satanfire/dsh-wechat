import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
  for (const required of ['index.mjs', 'client.js', 'src/ownership.mjs', 'src/bridge.mjs', 'cordis.patch.yml', 'LICENSE', 'README.md', 'locale/en.json', 'scripts/recover.mjs', 'docs/verification.md', 'vendor/qrcode.cjs', 'vendor/licenses.txt', 'vendor/manifest.json']) {
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
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}), []);
  assert.deepEqual(Object.keys(manifest.optionalDependencies ?? {}), []);
  for (const name of ['preinstall', 'install', 'postinstall', 'prepare', 'prepack']) {
    assert.equal(manifest.scripts?.[name], undefined, `Unexpected install lifecycle: ${name}`);
  }
  const installedRoot = path.join(temporary, 'consumer');
  await mkdir(installedRoot);
  await writeFile(path.join(installedRoot, 'package.json'), '{"name":"qr-package-check","private":true}');
  command(npm, ['install', '--omit=dev', '--ignore-scripts', '--offline', '--no-audit', '--no-fund', '--package-lock=false', path.join(temporary, packed.filename)], installedRoot);
  const topLevel = await readdir(path.join(installedRoot, 'node_modules'));
  assert.deepEqual(topLevel.filter(name => !name.startsWith('.')), ['@satanfire']);
  const installed = path.join(installedRoot, 'node_modules', '@satanfire', 'dsh-wechat');
  const script = `
    import assert from 'node:assert/strict';
    import { pathToFileURL } from 'node:url';
    const { Controller } = await import(pathToFileURL(${JSON.stringify(path.join(installed, 'src/controller.mjs'))}).href);
    const controller = new Controller({}, {}, {profile:'package-check'});
    const image = await controller.toQrDataUrl('isolated-login-test');
    assert.ok(image.startsWith('data:image/png;base64,'));
    const bytes = Buffer.from(image.split(',')[1], 'base64');
    assert.equal(bytes.readUInt32BE(16), 260);
    assert.equal(bytes.readUInt32BE(20), 260);
    console.log('Isolated production install: only the plugin directory; login QR generated.');
  `;
  console.log(command(process.execPath, ['--input-type=module', '-e', script], installedRoot).trim());
  console.log(`Verified real tarball: ${paths.length} files, ${packed.size} compressed bytes; portable Host imports passed.`);
} finally {
  const resolved = path.resolve(temporary);
  assert.equal(path.dirname(resolved), path.resolve(tmpdir()));
  assert.ok(path.basename(resolved).startsWith('dsh-wechat-package-'));
  await rm(resolved, { recursive: true, force: true });
}
