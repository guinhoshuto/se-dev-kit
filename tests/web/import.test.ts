import assert from 'node:assert/strict';
import test from 'node:test';
import {prepareSnapshot, safeAssetPath, isPublicAddress, fetchPublicAsset, type PublicAddress, type PublicTransport} from '../../lib/importer';
import {previewBackground, previewHtml, previewState} from '../../lib/preview';
import type {ObjectStore, ObjectValue, WidgetSnapshot} from '../../lib/model';

class MemoryStore implements ObjectStore {
  items = new Map<string, ObjectValue>();
  async get(key: string) { return this.items.get(key) ?? null; }
  async put(key: string, body: Uint8Array) { this.items.set(key, {body, etag: 'v1'}); return {etag: 'v1'}; }
  async list(prefix: string) { return [...this.items.keys()].filter(key => key.startsWith(prefix)); }
  async delete(key: string) { this.items.delete(key); }
}
const snapshot = (): WidgetSnapshot => ({schemaVersion: 1, name: 'Import fixture', widget: {html: '<main id="chat">Ready</main>', css: 'body { margin: 0 }', js: '', fields: {}, viewport: {width: 320, height: 240}}, channel: {}, themes: [], fixtures: [], scenes: [], scenarios: [], recipes: [], assets: []});

test('asset containment rejects traversal, encoded paths, reserved files, and private hosts', async () => {
  for (const path of ['../escape', '/absolute', 'a/../../b', '.env', 'a\\b', 'a%2fb', 'widget.js', 'a//b', 'a?b']) assert.throws(() => safeAssetPath(path));
  assert.equal(safeAssetPath('assets/image.png'), 'assets/image.png');
  for (const ip of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '0.0.0.0', '100.64.0.1', '::1', '::ffff:127.0.0.1', '2001:db8::1', 'fc00::1', 'fe80::1']) assert.equal(isPublicAddress(ip), false, ip);
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  await assert.rejects(fetchPublicAsset('https://127.0.0.1/secret'), /private/);
  await assert.rejects(fetchPublicAsset('http://example.com/'), /HTTPS/);
  await assert.rejects(fetchPublicAsset('https://user:secret@example.com/'), /credentials/);
});

type Reply = {status: number; body?: string; headers?: Record<string, string>};
/** Injected transport: records each attempt; `fail` addresses reject as a connection failure. */
function fakeTransport(reply: (url: string, attempt: number) => Reply, fail: string[] = []) {
  const attempts: {url: string; address: string; headers: Record<string, string>}[] = [];
  const transport: PublicTransport = async ({url, address, headers}) => {
    attempts.push({url: url.href, address: address.address, headers});
    if (fail.includes(address.address)) throw new Error('connect ECONNREFUSED');
    const answer = reply(url.href, attempts.length);
    const body = Buffer.from(answer.body ?? '');
    return {status: answer.status, headers: {'content-length': String(body.byteLength), ...answer.headers}, body: (async function* () { if (body.byteLength) yield body; })(), close() {}};
  };
  return {attempts, transport};
}
const answers = (...list: PublicAddress[]) => async () => list;

test('fetchPublicAsset keeps its defaults for existing callers and bounds the font path', async () => {
  const lookup = answers({address: '8.8.8.8', family: 4});
  const followed = fakeTransport((_url, attempt) => attempt === 1 ? {status: 301, headers: {location: '/moved.css'}} : {status: 200, body: 'body{}', headers: {'content-type': 'text/css; charset=utf-8'}});
  const asset = await fetchPublicAsset('https://cdn.example.com/a.css', {lookup, transport: followed.transport});
  assert.deepEqual([asset.body.toString(), asset.contentType, asset.url], ['body{}', 'text/css', 'https://cdn.example.com/moved.css']);
  assert.deepEqual(followed.attempts[0]!.headers, {'User-Agent': 'SE-Widget-Studio/0.2', Accept: '*/*'});
  const loop = fakeTransport(() => ({status: 302, headers: {location: '/again'}}));
  await assert.rejects(fetchPublicAsset('https://cdn.example.com/a.css', {lookup, transport: loop.transport}), /redirect limit/);
  assert.equal(loop.attempts.length, 5, 'four redirects are followed, as before');
  const refused = fakeTransport(() => ({status: 301, headers: {location: '/moved.css'}}));
  await assert.rejects(fetchPublicAsset('https://fonts.googleapis.com/css2?family=Archivo', {maxRedirects: 0, lookup, transport: refused.transport}), /redirects are not allowed/);
  assert.equal(refused.attempts.length, 1);
  const elsewhere = fakeTransport(() => ({status: 200}));
  await assert.rejects(fetchPublicAsset('https://example.com/a.woff2', {allowedHosts: ['fonts.gstatic.com'], lookup, transport: elsewhere.transport}), /not allowed/);
  assert.equal(elsewhere.attempts.length, 0);
  const truncated: PublicTransport = async () => ({status: 200, headers: {'content-length': '10'}, body: (async function* () { yield Buffer.from('12345'); })(), close() {}});
  await assert.rejects(fetchPublicAsset('https://cdn.example.com/a.css', {lookup, transport: truncated}), /Content-Length/);
  await assert.rejects(fetchPublicAsset('https://cdn.example.com/a.css', {lookup: answers({address: '8.8.8.8', family: 4}, {address: '10.0.0.1', family: 4}), transport: elsewhere.transport}), /private/);
  assert.equal(elsewhere.attempts.length, 0);
});

test('fetchPublicAsset tries every validated address in turn, IPv4 first when asked, and reports the one used', async () => {
  const lookup = answers({address: '2606:4700:4700::1111', family: 6}, {address: '8.8.8.8', family: 4}, {address: '1.1.1.1', family: 4});
  const flaky = fakeTransport(() => ({status: 200, body: 'ok'}), ['8.8.8.8']);
  const asset = await fetchPublicAsset('https://fonts.gstatic.com/s/a/v1/a.woff2', {preferIpv4: true, lookup, transport: flaky.transport});
  assert.deepEqual(flaky.attempts.map(attempt => attempt.address), ['8.8.8.8', '1.1.1.1']);
  assert.equal(asset.address, '1.1.1.1');
  const dnsOrder = fakeTransport(() => ({status: 200, body: 'ok'}));
  assert.equal((await fetchPublicAsset('https://fonts.gstatic.com/s/a/v1/a.woff2', {lookup, transport: dnsOrder.transport})).address, '2606:4700:4700::1111');
  const down = fakeTransport(() => ({status: 200}), ['2606:4700:4700::1111', '8.8.8.8', '1.1.1.1']);
  await assert.rejects(fetchPublicAsset('https://fonts.gstatic.com/s/a/v1/a.woff2', {lookup, transport: down.transport}), /could not be reached/);
  assert.equal(down.attempts.length, 3);
  const answered = fakeTransport(() => ({status: 503}));
  await assert.rejects(fetchPublicAsset('https://fonts.gstatic.com/s/a/v1/a.woff2', {lookup, transport: answered.transport}), /HTTP 503/);
  assert.equal(answered.attempts.length, 1, 'an HTTP answer is final; only connection failures move to the next address');
});

test('preparation captures dependencies without mutating source and defers classic scripts', async () => {
  const source = snapshot();
  source.widget.html = '<link rel="stylesheet" href="styles/main.css"><main id="chat"><img src="assets/pixel.svg"></main><script>window.seedAtLoad = Math.random()</script><script src="scripts/dependency.js"></script><script src="widget.js"></script>';
  source.widget.css = 'body {background-image: url("assets/pixel.svg")}';
  source.widget.fields = {image: {type: 'image-input', value: 'assets/pixel.svg'}};
  source.assets = [
    {path: 'styles/main.css', content: 'main {background:url(../assets/pixel.svg)}'},
    {path: 'scripts/dependency.js', content: 'window.dep = true'},
    {path: 'assets/pixel.svg', content: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'}
  ];
  const original = structuredClone(source);
  const store = new MemoryStore();
  const prepared = await prepareSnapshot(source, store, 'projects/fixture/revision');
  assert.deepEqual(source, original);
  assert.equal(prepared.assets.length, 3);
  assert.match(prepared.snapshot.widget.html, /type="application\/x-sws-classic"/);
  assert.match(prepared.snapshot.widget.html, /data-sws-src="scripts\/dependency.js"/);
  assert.doesNotMatch(prepared.snapshot.widget.html, /src="widget.js"/);
  assert.deepEqual(prepared.snapshot.assets, []);
  const html = await previewHtml(prepared, store, {origin: 'http://127.0.0.1:3000', sessionId: 'session', nonce: 'abcdefghijklmnop'});
  assert.match(html, /connect-src &#?[^;]*|connect-src 'none'/);
  assert.match(html, /data:image\/svg\+xml;base64/);
  assert.match(html, /installFrameRuntime/);
  assert.doesNotMatch(html, /<script[^>]*src="scripts/);
});

test('unsupported active HTML and missing assets fail preparation explicitly', async () => {
  for (const html of ['<iframe src="https://example.com"></iframe>', '<img onerror="alert(1)">', '<script type="module">export const x=1</script>', '<img src="missing.png">', '<img srcset="a.png 1x,b.png 2x">']) {
    const source = snapshot(); source.widget.html = html;
    await assert.rejects(prepareSnapshot(source, new MemoryStore(), 'fixture'));
  }
});

test('preview field priority matches shared engine defaults, theme, fixture, scene, overrides', () => {
  const source = snapshot();
  source.widget.fields = {title: {type: 'text', value: 'Default'}, count: {type: 'number', value: 1}};
  source.themes = [{schemaVersion: 1, id: 'dark', name: 'Dark', fieldData: {title: 'Theme', count: 2}}];
  source.fixtures = [{schemaVersion: 1, id: 'chat', name: 'Chat', fieldData: {title: 'Fixture'}, events: []}];
  source.scenes = [{schemaVersion: 1, id: 'hero', name: 'Hero', theme: 'dark', fixture: 'chat', fieldData: {title: 'Scene'}}];
  const state = previewState(source, {sessionId: 'test', sceneId: 'hero', fieldData: {count: 7}});
  assert.deepEqual(state.fieldData, {title: 'Scene', count: 7});
  assert.equal(state.seed, 1337);
  assert.equal(state.fixedTime, '2025-01-15T12:00:00.000Z');
  assert.throws(() => previewState(source, {sessionId: 'test', themeId: 'missing'}), /Theme not found/);
});

test('tampered asset content is rejected before preview', async () => {
  const source = snapshot(); source.assets = [{path: 'assets/example.txt', content: 'original'}];
  const store = new MemoryStore();
  const prepared = await prepareSnapshot(source, store, 'fixture');
  await store.put(prepared.assets[0]!.key, Buffer.from('modified'));
  await assert.rejects(previewHtml(prepared, store, {origin: 'http://127.0.0.1:3000', sessionId: 'session', nonce: 'abcdefghijklmnop'}), /integrity/);
});

test('scene and matrix backgrounds are captured and validated without changing original source', async () => {
  const source = snapshot();
  source.scenes = [{schemaVersion: 1, id: 'hero', name: 'Hero', background: {id: 'picture', image: './assets/pixel.svg'}}];
  source.recipes = [{schemaVersion: 1, id: 'gallery', name: 'Gallery', scenes: ['hero'], matrix: {backgrounds: [{id: 'alternate', image: './assets/pixel.svg'}]}}];
  source.assets = [{path: 'assets/pixel.svg', content: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'}];
  const original = structuredClone(source);
  const prepared = await prepareSnapshot(source, new MemoryStore(), 'fixture');
  assert.deepEqual(source, original);
  assert.equal(prepared.snapshot.scenes[0]?.background?.image, 'assets/pixel.svg');
  assert.equal(prepared.snapshot.recipes[0]?.matrix?.backgrounds?.[0]?.image, 'assets/pixel.svg');
  source.scenes[0]!.background!.image = 'assets/missing.png';
  await assert.rejects(prepareSnapshot(source, new MemoryStore(), 'fixture'), /Missing asset/);
});

test('preview backgrounds use verified image bytes and never return a remote URL', async () => {
  const source = snapshot();
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>';
  source.scenes = [{schemaVersion: 1, id: 'hero', name: 'Hero', background: {id: 'picture', image: 'assets/pixel.svg'}}];
  source.assets = [{path: 'assets/pixel.svg', content: svg}];
  const store = new MemoryStore();
  const prepared = await prepareSnapshot(source, store, 'fixture');
  assert.equal(await previewBackground(prepared, store, {sceneId: 'hero'}), `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
  assert.equal(await previewBackground(prepared, store, {}), undefined);
  await store.put(prepared.assets[0]!.key, Buffer.from('tampered'));
  await assert.rejects(previewBackground(prepared, store, {sceneId: 'hero'}), /integrity/);
});
