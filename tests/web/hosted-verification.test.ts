import test from 'node:test';
import assert from 'node:assert/strict';
import {decodePng, fontsVerificationSnapshot, inspectPng, parseOptions, pngDifference, redact, verificationSnapshot, waitForDeployment} from '../../scripts/verify-hosted.mjs';
import {deflateSync} from 'node:zlib';
import {canonicalGoogleFontsUrl} from '../../src/runtime/google-fonts-url';
import {staticGoogleFontUrls} from '../../lib/fonts';
import {parseSnapshot} from '../../lib/schema';
import {execFile} from 'node:child_process';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

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

const NEW_COMMIT = 'c'.repeat(40);
const OLD_COMMIT = 'b'.repeat(40);
const versionAnswer = (commit: string) => Response.json({schemaVersion: 1, version: '0.2.0', commit, dirty: false});

test('--wait-for takes a commit SHA, has a bounded deadline and interval, and creates nothing', () => {
  const hosted = ['--base-url', 'https://studio.example/', '--allow-hosted'];
  const options = parseOptions([...hosted, '--wait-for', 'ABCDEF1']);
  assert.equal(options.waitFor, 'abcdef1');
  assert.equal(options.waitTimeoutMs, 600000);
  assert.equal(options.waitIntervalMs, 10000);
  assert.equal(parseOptions([...hosted, '--wait-for', NEW_COMMIT, '--wait-timeout', '3600', '--wait-interval', '300']).waitTimeoutMs, 3600000);
  assert.throws(() => parseOptions(['--base-url', 'https://studio.example/', '--wait-for', 'abcdef1']), /allow-hosted/);
  assert.throws(() => parseOptions([...hosted, '--wait-for', 'abcdef']), /7 to 40 hexadecimal/);
  assert.throws(() => parseOptions([...hosted, '--wait-for', 'abcdefg']), /7 to 40 hexadecimal/);
  assert.throws(() => parseOptions([...hosted, '--wait-for', 'abcdef1', '--fonts']), /creates nothing/);
  assert.throws(() => parseOptions([...hosted, '--wait-for', 'abcdef1', '--wait-timeout', '3601']), /--wait-timeout takes whole seconds from 1 to 3600/);
  assert.throws(() => parseOptions([...hosted, '--wait-for', 'abcdef1', '--wait-interval', '0']), /--wait-interval takes whole seconds from 1 to 300/);
  assert.throws(() => parseOptions([...hosted, '--wait-timeout', '30']), /belong to --wait-for/);
  assert.throws(() => parseOptions(['--integration', '--allow-sandbox', '--snapshot-id', 's', '--expected-team-id', 't', '--expected-project-id', 'p', '--wait-for', 'abcdef1']), /the --wait-\* flags/);
});

test('--wait-for returns once the deployed commit matches, after a 404 and an older commit', async () => {
  let clock = 0;
  const sleeps: number[] = [];
  const urls: string[] = [];
  const answers = [new Response('not found', {status: 404}), versionAnswer(OLD_COMMIT), versionAnswer(NEW_COMMIT)];
  const fetch = async (url: string) => {urls.push(url); return answers.shift()!;};
  const result = await waitForDeployment({origin: 'https://studio.example', waitFor: NEW_COMMIT.slice(0, 7), waitTimeoutMs: 600000, waitIntervalMs: 10000}, {fetch, now: () => clock, sleep: async (ms: number) => {sleeps.push(ms); clock += ms;}});
  assert.deepEqual(result, {status: 'deployed', commit: NEW_COMMIT, version: '0.2.0', dirty: false, checks: 3, waitedSeconds: 20});
  assert.deepEqual(sleeps, [10000, 10000]);
  assert.deepEqual(urls, Array(3).fill('https://studio.example/api/v1/version'));
});

test('--wait-for fails at its deadline and names the last answer', async () => {
  let clock = 0;
  let checks = 0;
  const fetch = async () => {checks++; return versionAnswer(OLD_COMMIT);};
  await assert.rejects(
    waitForDeployment({origin: 'https://studio.example', waitFor: NEW_COMMIT.slice(0, 12), waitTimeoutMs: 30000, waitIntervalMs: 10000}, {fetch, now: () => clock, sleep: async (ms: number) => {clock += ms;}}),
    /The deployment of cccccccccccc did not appear within 30 s: 4 checks of \/api\/v1\/version, the last answered commit bbbbbbbbbbbb\./
  );
  assert.equal(checks, 4, 'checks at 0, 10, 20 and 30 s, then the deadline');
});

test('verify-hosted --wait-for against a local server: exit 0 with the deployed build once it switches, exit 1 at the deadline', async t => {
  const script = fileURLToPath(new URL('../../scripts/verify-hosted.mjs', import.meta.url));
  let answers: (string | undefined)[] = [];
  const server = createServer((request, response) => {
    const commit = answers.length > 1 ? answers.shift() : answers[0];
    if (request.url !== '/api/v1/version' || !commit) {response.writeHead(404).end(); return;}
    response.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify({schemaVersion: 1, version: '0.2.0', commit, dirty: false}));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise<void>(done => server.close(() => done())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const run = (...args: string[]) => promisify(execFile)(process.execPath, [script, '--base-url', base, '--wait-for', NEW_COMMIT.slice(0, 7), '--wait-interval', '1', ...args]);
  answers = [undefined, OLD_COMMIT, NEW_COMMIT];
  const {stdout} = await run('--wait-timeout', '30');
  const printed = JSON.parse(stdout);
  assert.deepEqual({status: printed.status, commit: printed.commit, checks: printed.checks}, {status: 'deployed', commit: NEW_COMMIT, checks: 3});
  answers = [OLD_COMMIT];
  await assert.rejects(run('--wait-timeout', '1'), (error: {code?: number; stderr?: string}) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr ?? '', /did not appear within 1 s: \d+ checks of \/api\/v1\/version, the last answered commit bbbbbbbbbbbb/);
    return true;
  });
});
