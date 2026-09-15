import assert from 'node:assert/strict';
import test from 'node:test';
import {prepareSnapshot, safeAssetPath, isPublicAddress, fetchPublicAsset} from '../../lib/importer';
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
