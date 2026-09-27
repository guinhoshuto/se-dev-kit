import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ImmutableReadCache, LocalStore, readJson, writeJson} from '../../lib/storage';
import {FontMemory, lockForRevision, reserveFontBudget, resolveGoogleFont, servedDigest, writeLockEntry, type FontResolution, type ResolveGoogleFontOptions} from '../../lib/fonts';
import {createProject, restoreProject} from '../../lib/projects';
import type {PublicLookup, PublicTransport} from '../../lib/importer';
import type {ObjectStore} from '../../lib/model';
import {GOOGLE_FONTS_UA} from '../../src/runtime/google-fonts-url';

// Every test here injects DNS and transport: nothing reaches the network.
const lookup: PublicLookup = async () => [{address: '8.8.8.8', family: 4}];
type Reply = {status: number; body?: Uint8Array | string; headers?: Record<string, string>; contentLength?: number};
function upstream(handler: (url: string, call: number) => Reply | Promise<Reply>) {
  const calls: {url: string; headers: Record<string, string>; address: string}[] = [];
  const transport: PublicTransport = async ({url, address, headers}) => {
    calls.push({url: url.href, headers, address: address.address});
    const reply = await handler(url.href, calls.length);
    const body = Buffer.from(reply.body ?? '');
    return {status: reply.status, headers: {'content-length': String(reply.contentLength ?? body.byteLength), ...reply.headers}, body: (async function* () { if (body.byteLength) yield body; })(), close() {}};
  };
  return {calls, transport};
}
const tempStore = async () => new LocalStore(await mkdtemp(join(tmpdir(), 'studio-fonts-')));
const woff2 = (size = 64, seed = 0) => { const bytes = Buffer.alloc(size, seed); bytes.write('wOF2', 0, 'latin1'); return bytes; };
const CSS_URL = 'https://fonts.googleapis.com/css2?family=Archivo:wght@400';
const fileUrl = (index: number) => `https://fonts.gstatic.com/s/archivo/v19/file${index}.woff2`;
const face = (index: number, range?: string) => `@font-face { font-family: 'Archivo'; font-style: normal; font-weight: 400; src: url(${fileUrl(index)}) format('woff2');${range ? ` unicode-range: ${range};` : ''} }`;
const stylesheet = (count: number, range: (index: number) => string | undefined = () => undefined) => Array.from({length: count}, (_, index) => face(index, range(index))).join('\n');
/** Serves `css` for the stylesheet URL and a small woff2 for every gstatic URL. */
const googleLike = (css: string, fontBytes = () => woff2()) => (url: string): Reply => url.startsWith('https://fonts.googleapis.com/') ? {status: 200, body: css, headers: {'content-type': 'text/css; charset=utf-8'}} : {status: 200, body: fontBytes(), headers: {'content-type': 'font/woff2'}};
const options = (store: ObjectStore, transport: PublicTransport, extra: Partial<ResolveGoogleFontOptions> = {}): ResolveGoogleFontOptions => ({store, bucket: 'render', lookup, transport, memory: new FontMemory(), ...extra});
const ok = (result: FontResolution) => { assert.equal(result.status, 'ok', JSON.stringify({...result, body: undefined})); return result as Extract<FontResolution, {status: 'ok'}>; };

class CountingStore implements ObjectStore {
  gets: string[] = []; puts: string[] = [];
  constructor(readonly inner: ObjectStore) {}
  get(key: string) { this.gets.push(key); return this.inner.get(key); }
  put(key: string, body: Uint8Array, opts?: {contentType?: string; ifMatch?: string; overwrite?: boolean}) { this.puts.push(key); return this.inner.put(key, body, opts); }
  list(prefix: string) { return this.inner.list(prefix); }
  delete(key: string) { return this.inner.delete(key); }
}

test('a first resolve writes the object and the write-once index; the next resolve never calls upstream', async () => {
  const store = await tempStore();
  const google = upstream(googleLike(stylesheet(2)));
  const first = ok(await resolveGoogleFont(CSS_URL, options(store, google.transport)));
  assert.equal(first.source, 'upstream');
  assert.deepEqual(first.files, [fileUrl(0), fileUrl(1)]);
  assert.equal(first.partial, undefined);
  assert.equal(google.calls.length, 3, 'the stylesheet plus its two files, eagerly');
  assert.ok(await store.get(`fonts/v1/objects/${first.sha256}`));
  assert.equal((await store.list('fonts/v1/index/')).length, 3);
  const second = ok(await resolveGoogleFont(CSS_URL, options(store, google.transport)));
  const file = ok(await resolveGoogleFont(fileUrl(1), options(store, google.transport)));
  assert.equal(google.calls.length, 3);
  assert.equal(second.source, 'cache');
  assert.equal(second.sha256, first.sha256);
  assert.equal(file.source, 'cache');
  assert.equal(file.contentType, 'font/woff2');
});

test('concurrent resolves in two instances with different upstream bytes both serve the index winner', async () => {
  const store = await tempStore();
  let release!: () => void;
  const bothArrived = new Promise<void>(resolve => { release = resolve; });
  const google = upstream(async (_url, call) => { if (call === 2) release(); await bothArrived; return {status: 200, body: `/* instance ${call} */`}; });
  const [left, right] = await Promise.all([resolveGoogleFont(CSS_URL, options(store, google.transport)), resolveGoogleFont(CSS_URL, options(store, google.transport))]);
  assert.equal(google.calls.length, 2);
  assert.equal(ok(left).sha256, ok(right).sha256);
  assert.equal(Buffer.from(ok(left).body).toString(), Buffer.from(ok(right).body).toString());
  assert.equal((await store.list('fonts/v1/objects/')).length, 2, 'the loser object stays, unreferenced and harmless');
});

test('one instance coalesces concurrent resolves of the same URL into one upstream request', async () => {
  const store = await tempStore();
  const google = upstream(googleLike(stylesheet(0)));
  const memory = new FontMemory();
  const results = await Promise.all([1, 2, 3].map(() => resolveGoogleFont(CSS_URL, options(store, google.transport, {memory}))));
  assert.equal(google.calls.length, 1);
  results.forEach(ok);
});

test('an upstream 4xx is cached outside the index for one hour', async () => {
  const store = await tempStore();
  let clock = Date.parse('2026-09-27T12:00:00Z');
  const google = upstream(() => ({status: 400, body: 'bad family'}));
  const at = () => options(store, google.transport, {now: () => clock});
  const refused = await resolveGoogleFont(CSS_URL, at());
  assert.deepEqual([refused.status, refused.status === 'upstream-4xx' && refused.httpStatus, refused.status === 'upstream-4xx' && refused.source], ['upstream-4xx', 400, 'upstream']);
  assert.deepEqual(await store.list('fonts/v1/index/'), []);
  assert.equal((await store.list('fonts/v1/negative/')).length, 1);
  clock += 59 * 60 * 1000;
  const remembered = await resolveGoogleFont(CSS_URL, at());
  assert.equal(remembered.status === 'upstream-4xx' && remembered.source, 'negative');
  assert.equal(google.calls.length, 1);
  clock += 2 * 60 * 1000;
  await resolveGoogleFont(CSS_URL, at());
  assert.equal(google.calls.length, 2, 'after 1 h the negative entry expires and upstream is asked again');
});

test('429 and 5xx answers are never cached', async () => {
  for (const status of [429, 500, 503]) {
    const store = await tempStore();
    const google = upstream((_url, call) => call === 1 ? {status} : {status: 200, body: woff2()});
    const failed = await resolveGoogleFont(fileUrl(0), options(store, google.transport));
    assert.equal(failed.status === 'unavailable' && failed.reason, 'upstream', String(status));
    assert.deepEqual(await store.list('fonts/v1/negative/'), [], String(status));
    ok(await resolveGoogleFont(fileUrl(0), options(store, google.transport)));
    assert.equal(google.calls.length, 2, String(status));
  }
});

test('a redirect is refused without following it, and only the fixed User-Agent and Accept are sent', async () => {
  const store = await tempStore();
  const google = upstream(() => ({status: 302, headers: {location: fileUrl(9)}}));
  const redirected = await resolveGoogleFont(fileUrl(0), options(store, google.transport));
  assert.equal(redirected.status === 'unavailable' && redirected.reason, 'upstream');
  assert.equal(google.calls.length, 1);
  assert.deepEqual(Object.keys(google.calls[0]!.headers).sort(), ['Accept', 'User-Agent']);
  assert.equal(google.calls[0]!.headers['User-Agent'], GOOGLE_FONTS_UA);
  const pinned = upstream(() => ({status: 200, body: woff2()}));
  ok(await resolveGoogleFont(fileUrl(0), options(store, pinned.transport, {userAgent: 'Pinned-Revision-UA/1'})));
  assert.equal(pinned.calls[0]!.headers['User-Agent'], 'Pinned-Revision-UA/1');
});

test('a body shorter than its Content-Length is refused and nothing is cached', async () => {
  const store = await tempStore();
  const google = upstream(() => ({status: 200, body: woff2(50), contentLength: 100}));
  const truncated = await resolveGoogleFont(fileUrl(0), options(store, google.transport));
  assert.equal(truncated.status === 'unavailable' && truncated.reason, 'upstream');
  assert.match(truncated.status === 'unavailable' ? truncated.message : '', /Content-Length/);
  assert.deepEqual(await store.list('fonts/v1/'), []);
});

test('non-font bytes and invalid stylesheets are unavailable, not cached', async () => {
  const store = await tempStore();
  const html = upstream(() => ({status: 200, body: '<!doctype html><title>Error</title>'}));
  const notFont = await resolveGoogleFont(fileUrl(0), options(store, html.transport));
  assert.equal(notFont.status === 'unavailable' && notFont.reason, 'invalid');
  const hostile = upstream(() => ({status: 200, body: '@import url(https://example.com/x.css);'}));
  const badCss = await resolveGoogleFont(CSS_URL, options(store, hostile.transport));
  assert.equal(badCss.status === 'unavailable' && badCss.reason, 'invalid');
  assert.deepEqual(await store.list('fonts/v1/index/'), []);
});

test('placeholders are a local 400 and /icon is FONT_UNSUPPORTED, both without upstream', async () => {
  const store = await tempStore();
  const google = upstream(() => ({status: 200}));
  const placeholder = await resolveGoogleFont('https://fonts.googleapis.com/css?family={{fontName}}:400,700', options(store, google.transport));
  assert.equal(placeholder.status === 'upstream-4xx' && placeholder.source, 'local');
  const icon = await resolveGoogleFont('https://fonts.googleapis.com/icon?family=Material+Icons', options(store, google.transport));
  assert.equal(icon.status === 'unavailable' && icon.code, 'FONT_UNSUPPORTED');
  assert.equal(google.calls.length, 0);
});

test('a missing budget key starts at 0 instead of NaN, and an exhausted budget blocks upstream', async () => {
  const store = await tempStore();
  const now = Date.parse('2026-09-27T12:00:00Z');
  await writeJson(store, 'usage/fonts-2026-09-27.json', {render: 5});
  assert.equal(await reserveFontBudget(store, 'preview', 3, {now, limits: {preview: 2}}), false);
  assert.equal(await reserveFontBudget(store, 'preview', 2, {now, limits: {preview: 2}}), true);
  assert.deepEqual(await readJson(store, 'usage/fonts-2026-09-27.json'), {render: 5, preview: 2});
  const google = upstream(() => ({status: 200, body: woff2()}));
  const blocked = await resolveGoogleFont(fileUrl(0), options(store, google.transport, {bucket: 'preview', now: () => now, budgetLimits: {preview: 2}}));
  assert.equal(blocked.status === 'unavailable' && blocked.reason, 'budget');
  assert.equal(google.calls.length, 0);
  ok(await resolveGoogleFont(fileUrl(0), options(store, google.transport, {bucket: 'render', now: () => now})));
});

test('the budget is reserved per batch: one stylesheet and its files cost two reservations', async () => {
  const store = new CountingStore(await tempStore());
  const now = Date.parse('2026-09-27T12:00:00Z');
  const google = upstream(googleLike(stylesheet(5)));
  ok(await resolveGoogleFont(CSS_URL, options(store, google.transport, {now: () => now})));
  assert.equal(google.calls.length, 6);
  assert.deepEqual(await readJson(store, 'usage/fonts-2026-09-27.json'), {render: 6, preview: 0});
  assert.equal(store.puts.filter(key => key === 'usage/fonts-2026-09-27.json').length, 2);
});

test('a stylesheet listing more than 64 files downloads only files covering the sample text and marks the entry partial', async () => {
  const store = await tempStore();
  // Files 0 and 1 cover Basic Latin and the sample text; the other 68 cover only CJK.
  const google = upstream(googleLike(stylesheet(70, index => index === 0 ? 'U+0000-00FF' : index === 1 ? 'U+3042' : 'U+4E00-4E0F')));
  const entry = ok(await resolveGoogleFont(CSS_URL, options(store, google.transport, {sampleText: 'あ'})));
  assert.equal(entry.partial, true);
  assert.equal(entry.files?.length, 70);
  assert.deepEqual(google.calls.slice(1).map(call => call.url).sort(), [fileUrl(0), fileUrl(1)]);
  const again = ok(await resolveGoogleFont(CSS_URL, options(store, google.transport)));
  assert.equal(again.partial, true, 'the partial flag is stored in the index');
});

test('a stylesheet listing exactly 64 files downloads all of them', async () => {
  const store = await tempStore();
  const google = upstream(googleLike(stylesheet(64, () => 'U+4E00-4E0F')));
  const entry = ok(await resolveGoogleFont(CSS_URL, options(store, google.transport)));
  assert.equal(entry.partial, undefined);
  assert.equal(google.calls.length, 65);
});

test('eager downloads stop at 8 MB and mark the entry partial', async () => {
  const store = await tempStore();
  const google = upstream(googleLike(stylesheet(3), () => woff2(3 * 1024 * 1024)));
  const entry = ok(await resolveGoogleFont(CSS_URL, options(store, google.transport)));
  assert.equal(entry.partial, true);
  assert.equal((await store.list('fonts/v1/index/')).length, 3, 'the stylesheet and two 3 MB files; the third would pass 8 MB');
});

test('a SHA-256 mismatch on read gives unavailable', async () => {
  const store = await tempStore();
  const google = upstream(() => ({status: 200, body: '/* fixture */'}));
  const first = ok(await resolveGoogleFont(CSS_URL, options(store, google.transport)));
  // Same length, different bytes: only the SHA-256 check can notice.
  const tamperedBytes = Buffer.from(first.body);
  tamperedBytes[0] = tamperedBytes[0] === 0x20 ? 0x21 : 0x20;
  await store.put(`fonts/v1/objects/${first.sha256}`, tamperedBytes, {overwrite: true});
  const tampered = await resolveGoogleFont(CSS_URL, options(store, google.transport));
  assert.equal(tampered.status === 'unavailable' && tampered.reason, 'integrity');
  const lock = {projectId: 'project', revisionId: 'revision'};
  await writeLockEntry(store, lock.projectId, lock.revisionId, {url: CSS_URL, status: 200, sha256: first.sha256, bytes: first.bytes, contentType: 'text/css'});
  const replayed = await resolveGoogleFont(CSS_URL, options(store, google.transport, {lock}));
  assert.equal(replayed.status === 'unavailable' && replayed.reason, 'integrity');
  assert.equal(google.calls.length, 1);
});

test('the revision lock records ok and 4xx entries with status, idempotently, and replays a 4xx after the negative TTL', async () => {
  const store = await tempStore();
  let clock = Date.parse('2026-09-27T12:00:00Z');
  const lock = {projectId: 'project', revisionId: 'revision'};
  const missing = 'https://fonts.googleapis.com/css2?family=Does+Not+Exist';
  const google = upstream(url => url === missing ? {status: 400} : {status: 200, body: woff2()});
  const at = () => options(store, google.transport, {lock, now: () => clock});
  const font = ok(await resolveGoogleFont(fileUrl(0), at()));
  assert.equal((await resolveGoogleFont(missing, at())).status, 'upstream-4xx');
  const entries = await lockForRevision(store, lock.projectId, lock.revisionId);
  assert.deepEqual(entries, [
    {url: missing, status: 400},
    {url: fileUrl(0), status: 200, sha256: font.sha256, bytes: font.bytes, contentType: 'font/woff2'}
  ]);
  assert.equal(await writeLockEntry(store, lock.projectId, lock.revisionId, entries[1]!), 'exists');
  assert.equal(await writeLockEntry(store, lock.projectId, lock.revisionId, {url: fileUrl(0), status: 200, sha256: 'f'.repeat(64), bytes: 1, contentType: 'font/woff2'}), 'exists');
  assert.deepEqual(await lockForRevision(store, lock.projectId, lock.revisionId), entries, 'a repeated write never changes the lock');
  clock += 2 * 60 * 60 * 1000;
  const replayed = await resolveGoogleFont(missing, at());
  assert.equal(replayed.status === 'upstream-4xx' && replayed.source, 'lock');
  assert.equal(ok(await resolveGoogleFont(fileUrl(0), at())).source, 'lock');
  assert.equal(google.calls.length, 2);
  await resolveGoogleFont(missing, options(store, google.transport, {now: () => clock}));
  assert.equal(google.calls.length, 3, 'without the lock, the expired negative entry lets upstream be asked again');
  assert.equal(servedDigest(entries), servedDigest([...entries].reverse()));
  assert.notEqual(servedDigest(entries), servedDigest(entries.slice(1)));
});

test('the revision lock is capped at 512 URLs', async () => {
  const store = await tempStore();
  for (let index = 0; index < 512; index++) assert.equal(await writeLockEntry(store, 'project', 'capped', {url: `${fileUrl(index)}`, status: 404}), 'written');
  assert.equal(await writeLockEntry(store, 'project', 'capped', {url: fileUrl(600), status: 404}), 'full');
});

test('restoreProject copies the font lock to the restored revision', async () => {
  const store = await tempStore();
  const snapshot = {schemaVersion: 1, name: 'Fonts', widget: {html: '<main id="chat"></main>', css: 'body{margin:0}', js: '', fields: {}}};
  const created = await createProject(store, snapshot);
  const original = created.revision.id;
  await writeLockEntry(store, created.project.id, original, {url: CSS_URL, status: 200, sha256: 'a'.repeat(64), bytes: 10, contentType: 'text/css'});
  await writeLockEntry(store, created.project.id, original, {url: fileUrl(0), status: 404});
  const restored = await restoreProject(store, created.project.id, created.token, created.etag, original);
  assert.notEqual(restored.revision.id, original);
  assert.deepEqual(await lockForRevision(store, created.project.id, restored.revision.id), await lockForRevision(store, created.project.id, original));
});

test('immutable reads are single-flight, LRU-bounded, and never cache a missing key', async () => {
  const inner = await tempStore();
  const store = new CountingStore(inner);
  await inner.put('a', Buffer.from('aaaaaa'));
  await inner.put('b', Buffer.from('bbbbbb'));
  const cache = new ImmutableReadCache(10, 8);
  await Promise.all([cache.read(store, 'a'), cache.read(store, 'a')]);
  await cache.read(store, 'a');
  assert.equal(store.gets.filter(key => key === 'a').length, 1);
  assert.equal(await cache.read(store, 'missing'), null);
  await inner.put('missing', Buffer.from('now'));
  assert.equal(Buffer.from((await cache.read(store, 'missing'))!).toString(), 'now');
  await cache.read(store, 'b');
  assert.ok(cache.bytes <= 10);
  await cache.read(store, 'a');
  assert.equal(store.gets.filter(key => key === 'a').length, 2, '"a" was evicted to keep the cache within 10 bytes');
  const other = new CountingStore(inner);
  await cache.read(other, 'a');
  assert.equal(other.gets.length, 1, 'entries are scoped per store: "a" is cached for the first store only');
});
