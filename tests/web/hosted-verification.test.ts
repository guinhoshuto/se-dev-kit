import test from 'node:test';
import assert from 'node:assert/strict';
import {decodePng, fontsVerificationSnapshot, inspectPng, parseOptions, pngDifference, redact, verificationSnapshot} from '../../scripts/verify-hosted.mjs';
import {deflateSync} from 'node:zlib';
import {canonicalGoogleFontsUrl} from '../../src/runtime/google-fonts-url';
import {staticGoogleFontUrls} from '../../lib/fonts';
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

test('the fonts verification fixture is a valid snapshot with static, imported, runtime and missing Google Fonts', () => {
  assert.equal(parseOptions(['--base-url', 'https://studio.example/', '--allow-hosted', '--fonts']).fonts, true);
  const snapshot = parseSnapshot(fontsVerificationSnapshot());
  assert.deepEqual(snapshot.recipes.map(recipe => recipe.id), ['fonts-image']);
  assert.equal(snapshot.scenes[0]?.id, 'fonts');
  // Only families Google has are static: a missing one would block the revision at import.
  assert.deepEqual(staticGoogleFontUrls(snapshot), ['https://fonts.googleapis.com/css2?family=Roboto:wght@400;700&display=swap', 'https://fonts.googleapis.com/css2?family=Roboto&display=swap', 'https://fonts.googleapis.com/css2?family=Inter:wght@400&display=swap'].map(url => (canonicalGoogleFontsUrl(url) as {url: string}).url));
  assert.match(snapshot.widget.js, /Studio\+Verification\+Missing\+Family/);
});

/** A minimal RGBA PNG whose rows use filters 0 to 4 in turn, so the decoder meets each one. */
function png(width: number, height: number, pixel: (x: number, y: number) => number[]): Buffer {
  const rows: Buffer[] = []; let previous = Buffer.alloc(width * 4);
  for (let y = 0; y < height; y++) {
    const line = Buffer.alloc(width * 4);
    for (let x = 0; x < width; x++) Buffer.from(pixel(x, y)).copy(line, x * 4);
    const filter = y % 5; const out = Buffer.alloc(line.length);
    for (let i = 0; i < line.length; i++) {
      const left = i >= 4 ? line[i - 4]! : 0, up = previous[i]!, corner = i >= 4 ? previous[i - 4]! : 0;
      const p = left + up - corner, pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - corner);
      const predictor = [0, left, up, (left + up) >> 1, pa <= pb && pa <= pc ? left : pb <= pc ? up : corner][filter]!;
      out[i] = (line[i]! - predictor) & 255;
    }
    rows.push(Buffer.concat([Buffer.from([filter]), out])); previous = line;
  }
  const chunk = (type: string, data: Buffer) => { const length = Buffer.alloc(4); length.writeUInt32BE(data.length); return Buffer.concat([length, Buffer.from(type), data, Buffer.alloc(4)]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

test('renders from two Sandboxes are compared by pixels within a tolerance, not by SHA-256', () => {
  const base = (x: number, y: number) => [(x * 37 + y * 11) & 255, (x * 5 + y * 71) & 255, (x * y) & 255, 255];
  const reference = png(20, 10, base);
  assert.deepEqual([...decodePng(reference).pixels.subarray(0, 8)], [...base(0, 0), ...base(1, 0)]);
  assert.deepEqual([...decodePng(reference).pixels.subarray((9 * 20 + 19) * 4)], base(19, 9));
  // Rasterization noise below the threshold on every pixel: equal.
  assert.equal(pngDifference(reference, png(20, 10, (x, y) => base(x, y).map((value, channel) => channel < 3 ? Math.min(255, value + 3) : value))), 0);
  // One pixel in 200 changed a lot: 0.5 %.
  assert.equal(pngDifference(reference, png(20, 10, (x, y) => x === 3 && y === 4 ? [255 - base(x, y)[0]!, 0, 0, 255] : base(x, y))), 1 / 200);
  assert.throws(() => pngDifference(reference, png(10, 10, base)), /different dimensions/);
});
