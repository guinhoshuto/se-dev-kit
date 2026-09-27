import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {prepareSnapshot} from '../../lib/importer';
import {previewBackground, previewHtml} from '../../lib/preview';
import {materializeSnapshot} from '../../lib/materialize';
import {SANDBOX_ENGINE_FOLDERS, runJob} from '../../lib/jobs';
import {LocalStore} from '../../lib/storage';
import {deployedSampleMedia, type SampleMediaSource} from '../../lib/sample-media';
import {loadSampleMediaCatalog} from '../../src/config/sample-media';
import {splitFieldOverrides, withBackgroundImage, type SampleMediaSummary} from '../../src/studio-ui/sample-media';
import {stageBackgroundImage} from '../../components/stage-style';
import {GET as listSampleMedia} from '../../app/api/v1/sample-media/route';
import type {Job, ObjectStore, ObjectValue, Revision, WidgetSnapshot} from '../../lib/model';

class MemoryStore implements ObjectStore {
  items = new Map<string, ObjectValue>();
  async get(key: string) { return this.items.get(key) ?? null; }
  async put(key: string, body: Uint8Array) { this.items.set(key, {body, etag: 'v1'}); return {etag: 'v1'}; }
  async list(prefix: string) { return [...this.items.keys()].filter(key => key.startsWith(prefix)); }
  async delete(key: string) { this.items.delete(key); }
}
const manifest = JSON.parse(await readFile(resolve('sample-media/manifest.json'), 'utf8')) as {items: {reference: string; file: string; sha256: string; bytes: number; color: string; kind: string}[]};
const sha = (reference: string) => manifest.items.find(item => item.reference === reference)!.sha256;
const options = {origin: 'http://127.0.0.1:3000', sessionId: 'session', nonce: 'abcdefghijklmnop'};
const NEON = 'sws-sample:gallery/neon-city.jpg';
const OCEAN = 'sws-sample:gallery/ocean-moon.jpg';
const PIXEL = 'sws-sample:gallery/pixel-forest.jpg';
const AURORA = 'sws-sample:backdrops/aurora-mesh.jpg';

function snapshot(): WidgetSnapshot {
  return {
    schemaVersion: 1, name: 'Sample fixture',
    widget: {html: '<main id="widget"></main>', css: 'body{margin:0}', js: '', fields: {image: {type: 'image-input', value: ''}, gallery: {type: 'image-input', multiple: true, value: []}, title: {type: 'text', value: 'Title'}}, viewport: {width: 320, height: 240}},
    channel: {}, themes: [], fixtures: [{schemaVersion: 1, id: 'avatars', name: 'Avatars', events: [{atMs: 10, listener: 'avatar', event: {data: {avatar: PIXEL}}}]}],
    scenes: [
      {schemaVersion: 1, id: 'hero', name: 'Hero', fixture: 'avatars', fieldData: {image: NEON, gallery: [OCEAN, NEON]}, background: {id: 'aurora', image: AURORA, color: '#2e2b52'}},
      {schemaVersion: 1, id: 'other', name: 'Other', fieldData: {image: 'sws-sample:gallery/cozy-desk.jpg'}}
    ],
    scenarios: [], recipes: [{schemaVersion: 1, id: 'matrix', name: 'Matrix', scenes: ['hero'], matrix: {backgrounds: [{id: 'prism', image: 'sws-sample:backdrops/prism-sky.jpg'}]}}], assets: []
  };
}
function assetMapOf(html: string): Record<string, string> {
  const match = /installFrameRuntime\((\{.*\})\);/.exec(html);
  assert.ok(match, 'preview bootstrap is missing');
  return JSON.parse(match[1]!.replaceAll('\\u003c', '<')).assetMap;
}
const decodedSha = (dataUrl: string) => createHash('sha256').update(Buffer.from(dataUrl.split(',', 2)[1]!, 'base64')).digest('hex');

test('import keeps sample references literal, pins their hashes, and captures no sample asset', async () => {
  const source = snapshot();
  const original = structuredClone(source);
  const store = new MemoryStore();
  const prepared = await prepareSnapshot(source, store, 'projects/p/prepared/r');
  assert.deepEqual(source, original);
  assert.deepEqual(prepared.assets, []);
  assert.equal(store.items.size, 0, 'samples must not be written to Blob');
  const hero = prepared.snapshot.scenes[0]!;
  assert.equal(hero.fieldData?.image, NEON);
  assert.deepEqual(hero.fieldData?.gallery, [OCEAN, NEON]);
  assert.equal(hero.background?.image, AURORA);
  assert.equal(prepared.snapshot.recipes[0]?.matrix?.backgrounds?.[0]?.image, 'sws-sample:backdrops/prism-sky.jpg');
  assert.deepEqual(Object.keys(prepared.sampleMedia ?? {}), [AURORA, 'sws-sample:backdrops/prism-sky.jpg', 'sws-sample:gallery/cozy-desk.jpg', NEON, OCEAN, PIXEL].sort());
  assert.equal(prepared.sampleMedia?.[AURORA], sha(AURORA));

  const plain = await prepareSnapshot({...snapshot(), fixtures: [], scenes: [], recipes: []}, new MemoryStore(), 'p');
  assert.equal(plain.sampleMedia, undefined);
});

test('import rejects unknown samples, samples in widget source, and samples saved as FIELDS defaults', async () => {
  const unknown = snapshot(); unknown.scenes[0]!.fieldData = {gallery: ['sws-sample:gallery/missing.jpg']};
  await assert.rejects(prepareSnapshot(unknown, new MemoryStore(), 'p'), /Unknown sample media reference: sws-sample:gallery\/missing\.jpg/);
  const malformed = snapshot(); malformed.scenes[0]!.background = {id: 'bad', image: 'sws-sample:../package.json'};
  await assert.rejects(prepareSnapshot(malformed, new MemoryStore(), 'p'), /Unknown sample media reference/);
  const html = snapshot(); html.widget.html = `<img src="${NEON}">`;
  await assert.rejects(prepareSnapshot(html, new MemoryStore(), 'p'), /only in catalog values and scene backgrounds/);
  const css = snapshot(); css.widget.css = `body{background:url("${AURORA}")}`;
  await assert.rejects(prepareSnapshot(css, new MemoryStore(), 'p'), /only in catalog values and scene backgrounds/);
  const fields = snapshot(); fields.widget.fields = {image: {type: 'image-input', value: NEON}};
  await assert.rejects(prepareSnapshot(fields, new MemoryStore(), 'p'), /cannot be saved as FIELDS defaults/);
});

test('arrays of ordinary media paths keep their existing literal import behavior', async () => {
  const source = snapshot();
  source.scenes[0]!.fieldData = {gallery: ['/__sws/widget/studio/media/gallery/01-x.jpg', 'undeclared.png', NEON]};
  const prepared = await prepareSnapshot(source, new MemoryStore(), 'p');
  assert.deepEqual(prepared.snapshot.scenes[0]!.fieldData?.gallery, ['/__sws/widget/studio/media/gallery/01-x.jpg', 'undeclared.png', NEON]);
});

test('preview embeds only the samples the effective state and scene fixture use, as verified data URLs', async () => {
  const store = new MemoryStore();
  const prepared = await prepareSnapshot(snapshot(), store, 'p');
  const html = await previewHtml(prepared, store, {...options, sceneId: 'hero', fieldData: {title: 'Override', gallery: ['sws-sample:gallery/space-nebula.jpg']}});
  const assetMap = assetMapOf(html);
  // The override replaces the scene array; fixture events add their avatar; other scenes and the matrix stay out.
  assert.deepEqual(Object.keys(assetMap).sort(), [NEON, PIXEL, 'sws-sample:gallery/space-nebula.jpg'].sort());
  for (const [reference, dataUrl] of Object.entries(assetMap)) {
    assert.match(dataUrl, /^data:image\/jpeg;base64,/);
    assert.equal(decodedSha(dataUrl), sha(reference));
  }
  assert.equal(Object.keys(assetMapOf(await previewHtml(prepared, store, options))).length, 0, 'no scene means no embedded samples');
  const background = await previewBackground(prepared, store, {sceneId: 'hero'});
  assert.ok(background);
  assert.equal(decodedSha(background), sha(AURORA));
  assert.ok(!Object.keys(assetMap).includes(AURORA), 'the backdrop is sent once, as backgroundImage');
});

test('saved revisions fail clearly when a pinned sample changed instead of rendering other pixels', async () => {
  const store = new MemoryStore();
  const prepared = await prepareSnapshot(snapshot(), store, 'p');
  const tampered = {...prepared, sampleMedia: {...prepared.sampleMedia, [NEON]: '0'.repeat(64), [AURORA]: '1'.repeat(64)}};
  await assert.rejects(previewHtml(tampered, store, {...options, sceneId: 'hero'}), /Sample media changed since this revision was saved: sws-sample:gallery\/neon-city\.jpg/);
  await assert.rejects(previewBackground(tampered, store, {sceneId: 'hero'}), /Sample media changed since this revision was saved/);
});

async function catalogCopy(root: string, entries: {reference: string; file: string}[], mutate?: (file: string) => Promise<void>): Promise<SampleMediaSource> {
  const items = manifest.items.filter(item => entries.some(entry => entry.reference === item.reference));
  for (const item of items) {
    await mkdir(join(root, item.file, '..'), {recursive: true});
    await copyFile(resolve('sample-media', item.file), join(root, item.file));
    await mutate?.(join(root, item.file));
  }
  await writeFile(join(root, 'manifest.json'), JSON.stringify({schemaVersion: 1, items}));
  return () => loadSampleMediaCatalog(root);
}

test('an injected catalog enforces integrity and the shared 3 MB preview budget', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sws-sample-web-'));
  try {
    const broken = await catalogCopy(join(root, 'broken'), [{reference: NEON, file: 'gallery/neon-city.jpg'}], file => writeFile(file, 'tampered'));
    await assert.rejects(prepareSnapshot(snapshot(), new MemoryStore(), 'p', broken), /does not match its recorded size and SHA-256/);

    const large = join(root, 'large');
    const big = Buffer.alloc(1_600_000, 7);
    const items = ['one', 'two'].map(name => ({id: name, reference: `sws-sample:gallery/${name}.jpg`, file: `gallery/${name}.jpg`, kind: 'gallery', contentType: 'image/jpeg', width: 1, height: 1, bytes: big.byteLength, sha256: createHash('sha256').update(big).digest('hex'), label: name, alt: 'Synthetic test bytes', color: '#000000', origin: 'test'}));
    await mkdir(join(large, 'gallery'), {recursive: true});
    for (const item of items) await writeFile(join(large, item.file), big);
    await writeFile(join(large, 'manifest.json'), JSON.stringify({schemaVersion: 1, items}));
    const source: SampleMediaSource = () => loadSampleMediaCatalog(large);
    const heavy = snapshot(); heavy.fixtures = []; heavy.recipes = [];
    heavy.scenes = [{schemaVersion: 1, id: 'hero', name: 'Hero', fieldData: {gallery: items.map(item => item.reference)}}];
    const store = new MemoryStore();
    const prepared = await prepareSnapshot(heavy, store, 'p', source);
    await assert.rejects(previewHtml(prepared, store, {...options, sceneId: 'hero'}, source), /sample media counts toward this preview budget/i);
  } finally {await rm(root, {recursive: true, force: true});}
});

test('the deployed catalog is the repository sample-media directory', async () => {
  const catalog = await deployedSampleMedia();
  assert.equal(catalog.items.length, manifest.items.length);
  assert.ok(SANDBOX_ENGINE_FOLDERS.includes('sample-media'));
  const config = await readFile(resolve('next.config.mjs'), 'utf8');
  assert.match(config, /'\.\/sample-media\/\*\*\/\*'/, 'next.config.mjs must trace sample-media for every function');
  const packageJson = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as {files: string[]};
  assert.ok(packageJson.files.includes('sample-media'));
});

test('the capability-free sample media list announces support without serving bytes', async () => {
  const previous = process.env.VERCEL;
  delete process.env.VERCEL;
  try {
    const response = await listSampleMedia(new Request('http://127.0.0.1:3000/api/v1/sample-media'));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const text = await response.text();
    assert.equal(text.includes('data:'), false, 'the list must never carry sample bytes');
    const body = JSON.parse(text) as {schemaVersion: number; items: {reference: string; sha256: string; bytes: number}[]};
    assert.equal(body.schemaVersion, 1);
    assert.deepEqual(body.items.map(item => [item.reference, item.sha256, item.bytes]), manifest.items.map(item => [item.reference, item.sha256, item.bytes]));
    const foreign = await listSampleMedia(new Request('http://127.0.0.1:3000/api/v1/sample-media', {headers: {Origin: 'https://attacker.example'}}));
    assert.equal(foreign.status, 403);
  } finally {if (previous === undefined) delete process.env.VERCEL; else process.env.VERCEL = previous;}
});

test('materialized jobs never copy sample media into the widget', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sws-sample-materialize-'));
  try {
    const store = new LocalStore(join(root, 'store'));
    const prepared = await prepareSnapshot(snapshot(), store, 'p');
    const project = await materializeSnapshot(prepared, store, join(root, 'job'));
    const listing = async (directory: string): Promise<string[]> => (await Promise.all((await readdir(directory, {withFileTypes: true})).map(async entry => entry.isDirectory() ? listing(join(directory, entry.name)) : [join(directory, entry.name)]))).flat();
    const files = await listing(project.widgetRoot);
    assert.equal(files.some(file => file.endsWith('.jpg')), false);
    assert.deepEqual(project.config.widget.assets, []);
  } finally {await rm(root, {recursive: true, force: true});}
});

test('editor helpers keep samples out of FIELDS and send only safe images to the stage', () => {
  assert.deepEqual(splitFieldOverrides({title: 'x', image: NEON, gallery: [OCEAN]}, false), {persist: {title: 'x'}, temporary: {image: NEON, gallery: [OCEAN]}});
  assert.deepEqual(splitFieldOverrides({image: NEON}, true), {persist: {image: NEON}, temporary: {}});
  const samples: SampleMediaSummary[] = manifest.items.map(item => ({reference: item.reference, kind: item.kind as 'gallery' | 'backdrop', label: item.reference, alt: '', width: 1, height: 1, color: item.color}));
  assert.deepEqual(withBackgroundImage({id: 'bg', checkerboard: true}, AURORA, samples), {id: 'bg', checkerboard: true, color: '#2e2b52', image: AURORA});
  assert.deepEqual(withBackgroundImage({id: 'bg', color: '#ffffff'}, AURORA, samples), {id: 'bg', color: '#ffffff', image: AURORA});
  assert.deepEqual(withBackgroundImage({id: 'bg', color: '#ffffff', image: AURORA}, '', samples), {id: 'bg', color: '#ffffff'});
  assert.equal(stageBackgroundImage('data:image/jpeg;base64,AAAA'), 'url("data:image/jpeg;base64,AAAA")');
  for (const value of ['data:image/jpeg;base64,AAAA") , url("https://example.com/x', 'data:image/svg+xml;base64,AAAA', 'https://example.com/a.jpg', 'data:image/png,raw', undefined]) assert.equal(stageBackgroundImage(value), undefined, String(value));
});

function job(kind: Job['kind'], selection: string): Job {
  return {id: `job-sample-${kind}`, projectId: 'project-sample', revisionId: 'revision-sample', kind, selection, status: 'queued', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), progress: 'Queued', artifacts: []};
}
function workerRevision(pins?: Record<string, string>): Revision {
  const value: WidgetSnapshot = {
    schemaVersion: 1, name: 'Sample worker',
    widget: {
      html: '<main id="widget"><div id="gallery"></div></main>', css: 'body{margin:0}img{width:40px;height:30px}',
      js: 'window.addEventListener("onWidgetLoad",({detail})=>{const list=Array.isArray(detail.fieldData.gallery)?detail.fieldData.gallery:[];document.querySelector("#gallery").replaceChildren(...list.map(value=>{const url=new URL(value,window.location.href);const image=document.createElement("img");image.addEventListener("load",()=>{image.dataset.width=String(image.naturalWidth);});image.src=["http:","https:"].includes(url.protocol)?url.href:"";return image;}));});',
      fields: {gallery: {type: 'image-input', multiple: true, value: []}}, viewport: {width: 160, height: 120}, ready: {selector: '#widget', timeoutMs: 5000}
    },
    channel: {}, themes: [], fixtures: [],
    scenes: [{schemaVersion: 1, id: 'default', name: 'Default', output: {width: 160, height: 120}, fieldData: {gallery: [NEON, PIXEL]}, background: {id: 'aurora', image: AURORA}, captureAtMs: 0}],
    scenarios: [{schemaVersion: 1, id: 'samples', name: 'Samples', steps: [{action: 'assert', selector: '#gallery img[data-width="1600"]', count: 2}]}],
    recipes: [{schemaVersion: 1, id: 'image', name: 'Image', scenes: ['default'], outputs: {screenshots: true}}], assets: []
  };
  return {id: 'revision-sample', projectId: 'project-sample', createdAt: new Date().toISOString(), snapshot: value, status: 'ready', diagnostics: [], prepared: {snapshot: value, assets: [], warnings: [], sampleMedia: pins ?? {[AURORA]: sha(AURORA), [NEON]: sha(NEON), [PIXEL]: sha(PIXEL)}}};
}

test('local worker renders and tests sample media offline and rejects changed pins', {timeout: 120_000}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sws-sample-worker-'));
  try {
    const store = new LocalStore(join(root, 'store'));
    const tested = await runJob(job('test', 'all'), workerRevision(), store);
    assert.equal(tested.status, 'completed', tested.error);
    const report = JSON.parse(Buffer.from((await store.get(tested.artifacts[0]!.key))!.body).toString());
    assert.equal(report.scenarios[0].status, 'passed', JSON.stringify(report.scenarios[0]));
    const rendered = await runJob(job('render', 'image'), workerRevision(), store);
    assert.equal(rendered.status, 'completed', rendered.error);
    const manifestArtifact = rendered.artifacts.find(item => item.name.endsWith('manifest.json'))!;
    const renderManifest = JSON.parse(Buffer.from((await store.get(manifestArtifact.key))!.body).toString());
    assert.equal(renderManifest.widget.sampleMediaHashes[AURORA], sha(AURORA));
    const changed = await runJob({...job('test', 'all'), id: 'job-sample-changed'}, workerRevision({[NEON]: '0'.repeat(64)}), store);
    assert.equal(changed.status, 'failed');
    assert.match(changed.error ?? '', /Sample media changed since this revision was saved/);
  } finally {await rm(root, {recursive: true, force: true});}
});
