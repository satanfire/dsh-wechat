import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import QRCode from 'qrcode';
import { PNG } from 'pngjs';
import bundled from '../vendor/qrcode.cjs';
import { Controller } from '../src/controller.mjs';

for (const text of ['https://example.invalid/qr?code=test', '微信扫码测试 🌏', '1234567890']) {
  test(`bundled QR PNG preserves upstream pixels for ${text}`, async () => {
    const options = { width: 260, margin: 2 };
    const actual = await bundled.toDataURL(text, options);
    const expected = await QRCode.toDataURL(text, options);
    assert.match(actual, /^data:image\/png;base64,/);
    const decode = url => PNG.sync.read(Buffer.from(url.split(',')[1], 'base64'));
    const left = decode(actual), right = decode(expected);
    assert.equal(left.width, right.width);
    assert.equal(left.height, right.height);
    assert.deepEqual(left.data, right.data);
  });
}

test('login uses bundled QR code without an external runtime import', async () => {
  const controller = new Controller({}, {}, { profile: 'qr-test' });
  const image = await controller.toQrDataUrl('qr-login-fixture');
  const png = PNG.sync.read(Buffer.from(image.split(',')[1], 'base64'));
  assert.equal(png.width, 260);
  assert.equal(png.height, 260);
});

test('QR bundle includes only expected dependencies and matches provenance hash', async () => {
  const manifest = JSON.parse(await readFile(new URL('../vendor/manifest.json', import.meta.url), 'utf8'));
  const code = await readFile(new URL('../vendor/qrcode.cjs', import.meta.url));
  assert.equal(createHash('sha256').update(code).digest('hex'), manifest.sha256);
  assert.deepEqual(manifest.packages.map(item => item.name), ['dijkstrajs', 'pngjs', 'qrcode']);
  assert.ok(manifest.inputs.every(input => !input.includes('yargs') && !input.includes('/bin/')));
  const licenses = await readFile(new URL('../vendor/licenses.txt', import.meta.url), 'utf8');
  for (const item of manifest.packages) assert.ok(licenses.includes(`${item.name}@${item.version}`));
});
