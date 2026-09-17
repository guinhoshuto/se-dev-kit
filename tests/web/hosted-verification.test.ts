import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectPng, parseOptions, redact, verificationSnapshot} from '../../scripts/verify-hosted.mjs';
import {parseSnapshot} from '../../lib/schema';

test('hosted verification requires an explicit HTTPS production opt-in', () => {
  assert.throws(() => parseOptions(['--base-url', 'https://studio.example']), /allow-hosted/);
  assert.equal(parseOptions(['--base-url', 'https://studio.example/', '--allow-hosted']).origin, 'https://studio.example');
  assert.equal(parseOptions(['--base-url', 'http://127.0.0.1:3000/']).origin, 'http://127.0.0.1:3000');
  assert.throws(() => parseOptions(['--base-url', 'https://studio.example/', '--base-url', 'https://studio.example/', '--allow-hosted']), /only appear once/);
  assert.throws(() => parseOptions(['--base-url', 'https://studio.example/', '--allow-hosted', '--ffprobe', 'one', '--ffprobe', 'two']), /only appear once/);
});

test('hosted verification fixture is a valid bounded studio snapshot', () => {
  const snapshot = parseSnapshot(verificationSnapshot());
  assert.equal(snapshot.widget.viewport.width, 320);
  assert.deepEqual(snapshot.recipes.map(recipe => recipe.id), ['verification-image', 'verification-video']);
  assert.equal(snapshot.scenarios[0]?.id, 'verification-smoke');
});

test('hosted evidence helpers validate PNG dimensions and redact capabilities', () => {
  const png = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(png);
  Buffer.from('IHDR').copy(png, 12);
  png.writeUInt32BE(320, 16);
  png.writeUInt32BE(240, 20);
  assert.deepEqual(inspectPng(png), {width: 320, height: 240});
  assert.throws(() => inspectPng(Buffer.from('not a png')), /not a PNG/);
  const secret = 'private-capability';
  const result = redact(`Bearer ${secret} https://example.com/#key=${secret}`, [secret]);
  assert.equal(result.includes(secret), false);
  assert.match(result, /REDACTED/);
});
