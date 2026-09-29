// Stage 6 of docs/plans/google-fonts.md: the editor preview's server side. The public cache-only font
// route, the authenticated broker route, server-side CSS in previewDocument and the importer that no
// longer captures Google Fonts. Every upstream is injected: nothing here reaches the network.
import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import {readFileSync} from 'node:fs';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GET as fontFile} from '../../app/api/fonts/v1/f/[file]/route';
import {POST as fontRequest} from '../../app/api/studio/projects/[id]/fonts/route';
import {POST as preview} from '../../app/api/studio/projects/[id]/preview/route';
import {FontMemory, PREVIEW_FONT_RATE_LIMIT, clientAddress, cssForPreview, fontFileResponse, lockForRevision, previewFontAnswer, publicFontUrl, resolveGoogleFont, takeFontFileRequest, takePreviewFontRequest} from '../../lib/fonts';
import {prepareSnapshot, type PublicLookup, type PublicTransport} from '../../lib/importer';
import {previewDocument, type PreviewFontSource} from '../../lib/preview';
import {createProject} from '../../lib/projects';
import {LocalStore} from '../../lib/storage';
import type {ObjectStore, PreparedSnapshot, WidgetSnapshot} from '../../lib/model';
import {FONT_CACHE_EPOCH, GOOGLE_FONTS_UA} from '../../src/runtime/google-fonts-url';

const FONT = readFileSync(new URL('../fixtures/fonts/Unbounded-400.woff2', import.meta.url));
const ORIGIN = 'http://127.0.0.1:3000';
const lookup: PublicLookup = async () => [{address: '8.8.8.8', family: 4}];
const css2 = (family: string) => `https://fonts.googleapis.com/css2?family=${family.replace(/ /g, '+')}`;
const fileUrl = (family: string, subset = 'latin') => `https://fonts.gstatic.com/s/${family.toLowerCase().replace(/ /g, '')}/v1/${subset}.woff2`;
const face = (family: string, subset: string, range: string) => `@font-face { font-family: '${family}'; font-style: normal; font-weight: 400; src: url(${fileUrl(family, subset)}) format('woff2'); unicode-range: ${range}; }`;
const LATIN = 'U+0000-00FF';
const CJK = 'U+4E00-9FFF';

/** A fake Google: stylesheets list a latin and a CJK subset; `refuse` families answer 400, `down` files 503. */
function google(options: {refuse?: string[]; down?: (url: string) => boolean} = {}) {
  const calls: string[] = [];
  const transport: PublicTransport = async ({url}) => {
    calls.push(url.href);
    let status = 200;
    let body: Buffer;
    if (url.hostname === 'fonts.googleapis.com') {
      const family = (url.searchParams.get('family') ?? '').split(':')[0]!;
      if (options.refuse?.includes(family)) { status = 400; body = Buffer.from('bad family'); }
      else body = Buffer.from(`${face(family, 'latin', LATIN)}\n${face(family, 'cjk', CJK)}`);
    } else if (options.down?.(url.href)) { status = 503; body = Buffer.from('down'); }
    else body = FONT;
    return {status, headers: {'content-length': String(body.byteLength), 'content-type': url.hostname === 'fonts.googleapis.com' ? 'text/css' : 'font/woff2'}, body: (async function* () { yield body; })(), close() {}};
  };
  return {calls, transport};
}

class CountingStore implements ObjectStore {
  gets: string[] = []; puts: string[] = [];
  constructor(readonly inner: ObjectStore) {}
  get(key: string) { this.gets.push(key); return this.inner.get(key); }
  put(key: string, body: Uint8Array, options?: {contentType?: string; ifMatch?: string; overwrite?: boolean}) { this.puts.push(key); return this.inner.put(key, body, options); }
  list(prefix: string) { return this.inner.list(prefix); }
  delete(key: string) { return this.inner.delete(key); }
}

/** A LocalStore that the routes' getStore() also opens (STUDIO_STORAGE=local). */
async function localStudio(t: TestContext): Promise<LocalStore> {
  const directory = await mkdtemp(join(tmpdir(), 'sws-preview-fonts-'));
  const keys = ['VERCEL', 'STUDIO_STORAGE', 'STUDIO_DATA_DIR', 'STUDIO_CREATE_KEY'] as const;
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  delete process.env.VERCEL;
  delete process.env.STUDIO_CREATE_KEY;
  process.env.STUDIO_STORAGE = 'local';
  process.env.STUDIO_DATA_DIR = directory;
  t.after(async () => {
    for (const key of keys) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key];
    await rm(directory, {recursive: true, force: true});
  });
  return new LocalStore(directory);
}

/** Puts a family's stylesheet and both subsets into the cache, in the default epoch and User-Agent. */
async function seed(store: ObjectStore, family: string, options: {down?: (url: string) => boolean} = {}) {
  const upstream = google(options);
  const result = await resolveGoogleFont(css2(family), {store, bucket: 'render', lookup, transport: upstream.transport, memory: new FontMemory()});
  assert.equal(result.status, 'ok');
  return upstream;
}

const snapshot = (widget: Partial<WidgetSnapshot['widget']> = {}): WidgetSnapshot => ({schemaVersion: 1, name: 'Preview fonts', widget: {html: '<main id="ready">Ready</main>', css: 'body{margin:0}', js: '', fields: {}, viewport: {width: 320, height: 120}, ...widget}, channel: {}, themes: [], fixtures: [], scenes: [], scenarios: [], recipes: [], assets: []});
const dataCss = (html: string, family: string) => {
  const match = new RegExp(`<link[^>]*href="data:text/css;base64,([^"]+)"[^>]*data-sws-original-href="${css2(family).replace(/[.?+]/g, '\\$&')}"`).exec(html);
  assert.ok(match, `a data: link for ${family} with its original href: ${html.slice(0, 600)}`);
  return Buffer.from(match[1]!, 'base64').toString('utf8');
};
const request = (path: string, init: RequestInit & {token?: string; json?: unknown} = {}) => new Request(ORIGIN + path, {
  method: init.method ?? (init.json === undefined ? 'GET' : 'POST'),
  headers: {...(init.token ? {Authorization: `Bearer ${init.token}`} : {}), ...(init.json === undefined ? {} : {'Content-Type': 'application/json'}), ...(init.headers as Record<string, string> | undefined)},
  ...(init.json === undefined ? {} : {body: JSON.stringify(init.json)})
});
const params = <T extends Record<string, string>>(value: T) => ({params: Promise.resolve(value)});

// Public route -------------------------------------------------------------------------------------

test('the public font route serves cached bytes to an opaque origin with immutable, cross-origin headers', async t => {
  const store = await localStudio(t);
  await seed(store, 'Studio Display');
  const href = await publicFontUrl(store, ORIGIN, (await resolveGoogleFont(fileUrl('Studio Display'), {store, bucket: 'preview', memory: new FontMemory()}) as {sha256: string}).sha256, 'font/woff2');
  assert.ok(href?.startsWith(`${ORIGIN}/api/fonts/v1/f/`));
  const file = href!.split('/').pop()!;
  assert.match(file, /^[0-9a-f]{64}\.[0-9a-f]{16}\.woff2$/);
  const response = await fontFile(request(`/api/fonts/v1/f/${file}`, {headers: {Origin: 'null'}}), params({file}));
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), FONT);
  assert.equal(response.headers.get('content-type'), 'font/woff2');
  assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(response.headers.get('cdn-cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'cross-origin');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('content-security-policy'), "default-src 'none'");
});

test('the public font route refuses queries, bad paths, bad MACs, other methods and unknown objects before or without upstream', async t => {
  const store = await localStudio(t);
  const upstream = await seed(store, 'Studio Display');
  const seeded = upstream.calls.length;
  const digest = (await resolveGoogleFont(fileUrl('Studio Display'), {store, bucket: 'preview', memory: new FontMemory()}) as {sha256: string}).sha256;
  const file = (await publicFontUrl(store, ORIGIN, digest, 'font/woff2'))!.split('/').pop()!;
  const counting = new CountingStore(store);
  const call = (name: string, init: RequestInit = {}, suffix = '') => fontFileResponse(request(`/api/fonts/v1/f/${name}${suffix}`, init), name, () => counting, new FontMemory());
  assert.equal((await call(file, {}, '?v=1')).status, 400, 'a query string');
  assert.equal((await call(file, {}, '?')).status, 400, 'an empty query string');
  for (const name of ['x.woff2', `${digest}.woff2`, `${digest}.${'0'.repeat(16)}.exe`, `${digest.toUpperCase()}.${file.split('.')[1]}.woff2`, `../${file}`]) {
    const response = await call(name);
    assert.equal(response.status, 404, name);
    assert.equal(response.headers.get('cache-control'), 'public, max-age=60', 'a short cache for misses');
  }
  assert.deepEqual(counting.gets, [], 'malformed paths never touch storage');
  const flipped = file.replace(/\.([0-9a-f])/, (_whole, first: string) => `.${first === '0' ? '1' : '0'}`);
  assert.equal((await call(flipped)).status, 404, 'a bad MAC');
  assert.ok(!counting.gets.some(key => key.startsWith('fonts/v1/objects/')), 'a bad MAC never reads an object');
  assert.equal((await call(file, {method: 'POST'})).status, 405);
  assert.equal((await call(file, {method: 'DELETE'})).status, 405);
  // A valid MAC for a SHA-256 the cache does not hold.
  const missing = (await publicFontUrl(store, ORIGIN, 'f'.repeat(64), 'font/woff2'))!.split('/').pop()!;
  assert.equal((await call(missing)).status, 404);
  // A font filed under another extension is not served.
  const asTtf = (await publicFontUrl(store, ORIGIN, digest, 'font/ttf'))!.split('/').pop()!;
  assert.equal((await call(asTtf)).status, 404);
  assert.equal((await call(file)).status, 200);
  assert.deepEqual(counting.puts, [], 'the route never writes');
  // Bytes that no longer match their SHA-256 are not served (a fresh memory, so the object is read again).
  const altered = Buffer.from(FONT);
  altered[altered.length - 1] ^= 0xff;
  await store.put(`fonts/v1/objects/${digest}`, altered, {overwrite: true});
  assert.equal((await call(file)).status, 404);
  assert.equal(upstream.calls.length, seeded, 'the route never calls upstream');
});

// cssForPreview ------------------------------------------------------------------------------------

test('cssForPreview points every url() at the public route and drops faces whose files are not cached', async t => {
  const store = await localStudio(t);
  // The CJK file is down when the stylesheet first enters the cache, so only the latin file is cached.
  await seed(store, 'Studio Display', {down: url => url.endsWith('/cjk.woff2')});
  const upstream = google({down: () => true});
  // A stylesheet none of whose files can be cached is not handed out as empty CSS.
  const nothing = await cssForPreview(css2('Nothing Cached'), {store, origin: ORIGIN, epoch: FONT_CACHE_EPOCH, userAgent: GOOGLE_FONTS_UA, deadline: Date.now() + 10_000, lookup, transport: upstream.transport, memory: new FontMemory()});
  assert.equal(nothing.status, 'unavailable');
  upstream.calls.length = 0;
  const base = {store, origin: ORIGIN, epoch: FONT_CACHE_EPOCH, userAgent: GOOGLE_FONTS_UA, deadline: Date.now() + 10_000, lookup, transport: upstream.transport, memory: new FontMemory()};
  const latin = await cssForPreview(css2('Studio Display'), base);
  assert.equal(latin.status, 'ok');
  assert.ok(latin.status === 'ok' && latin.kind === 'css');
  assert.equal(latin.partial, true);
  assert.doesNotMatch(latin.css, /gstatic|U\+4E00/, 'no Google URL and no uncached face is left');
  assert.match(latin.css, new RegExp(`url\\("${ORIGIN}/api/fonts/v1/f/[0-9a-f]{64}\\.[0-9a-f]{16}\\.woff2"\\)`));
  assert.deepEqual(upstream.calls, [], 'latin text needs nothing more from Google');
  // CJK text asks for the covering subset; Google is still down, so it stays partial.
  const stillDown = await cssForPreview(css2('Studio Display'), {...base, sampleText: '漢字'});
  assert.ok(stillDown.status === 'ok' && stillDown.kind === 'css' && stillDown.partial);
  assert.deepEqual(upstream.calls, [fileUrl('Studio Display', 'cjk')]);
  const recovered = google();
  const cjk = await cssForPreview(css2('Studio Display'), {...base, sampleText: '漢字', transport: recovered.transport});
  assert.ok(cjk.status === 'ok' && cjk.kind === 'css');
  assert.equal(cjk.partial, false);
  assert.match(cjk.css, /U\+4E00-9FFF/);
  assert.deepEqual(recovered.calls, [fileUrl('Studio Display', 'cjk')]);
});

test('previewFontAnswer refuses font files and unsupported URLs and reports 4xx without pinning local refusals', async t => {
  const store = await localStudio(t);
  const upstream = google({refuse: ['Nope']});
  const base = {store, origin: ORIGIN, epoch: FONT_CACHE_EPOCH, userAgent: GOOGLE_FONTS_UA, deadline: Date.now() + 10_000, lookup, transport: upstream.transport, memory: new FontMemory(), lock: {projectId: 'p1', revisionId: 'r1'}};
  assert.deepEqual(await previewFontAnswer(fileUrl('Studio Display'), base), {status: 'unavailable', code: 'FONT_UNSUPPORTED', reason: 'unsupported', message: `Only Google Fonts stylesheets load through a <link>, not ${fileUrl('Studio Display')}.`});
  const icon = await previewFontAnswer('https://fonts.googleapis.com/icon?family=Material+Icons', base);
  assert.equal(icon.status, 'unavailable');
  assert.equal(icon.status === 'unavailable' && icon.code, 'FONT_UNSUPPORTED');
  const placeholder = await previewFontAnswer(css2('{{font}}'), base);
  assert.equal(placeholder.status, 'upstream-4xx');
  const refused = await previewFontAnswer(css2('Nope'), base);
  assert.deepEqual(refused.status === 'upstream-4xx' && refused.httpStatus, 400);
  assert.deepEqual((await lockForRevision(store, 'p1', 'r1')).map(entry => [entry.url, entry.status]), [[css2('Nope'), 400]], 'Google\'s own 400 is pinned; the local one is not');
  assert.deepEqual(upstream.calls, [css2('Nope')]);
});

// previewDocument ----------------------------------------------------------------------------------

const fontSource = (store: ObjectStore, extra: Partial<Parameters<typeof cssForPreview>[1]> = {}): PreviewFontSource => (url, {sampleText, deadline}) =>
  cssForPreview(url, {store, origin: ORIGIN, epoch: FONT_CACHE_EPOCH, userAgent: GOOGLE_FONTS_UA, sampleText, deadline, memory: new FontMemory(), lookup, transport: google({refuse: ['Nope'], down: () => true}).transport, ...extra});
const previewOptions = {origin: ORIGIN, sessionId: 'session', nonce: 'abcdefghijklmnop'};

test('previewDocument resolves static Google links and @import on the server, keeps the CSP closed, and embeds no Google asset', async t => {
  const store = await localStudio(t);
  await seed(store, 'Studio Display');
  await seed(store, 'Imported Face');
  const prepared = await prepareSnapshot(snapshot({
    html: `<link rel="stylesheet" href="${css2('Studio Display')}"><link rel="stylesheet" href="${css2('Nope')}"><main id="ready">Ready</main>`,
    css: `@import url('${css2('Imported Face')}');body{font-family:'Imported Face'}`
  }), store, 'fixture');
  const {html, warnings} = await previewDocument(prepared, store, {...previewOptions, fonts: fontSource(store)});
  const csp = /content="([^"]+)"/.exec(html)![1]!;
  assert.match(csp, /font-src data: http:\/\/127\.0\.0\.1:3000\/api\/fonts\/v1\/f\/;/);
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /frame-src 'none'/);
  assert.match(csp, /style-src 'unsafe-inline' data:;/);
  assert.match(dataCss(html, 'Studio Display'), /url\("http:\/\/127\.0\.0\.1:3000\/api\/fonts\/v1\/f\/[0-9a-f]{64}\.[0-9a-f]{16}\.woff2"\)/);
  assert.doesNotMatch(html, /fonts\.gstatic\.com/);
  assert.match(html, /"fontBroker":true/);
  // The imported stylesheet is data: CSS inside the widget CSS.
  const widgetCss = Buffer.from(/<link rel="stylesheet" href="data:text\/css;base64,([^"]+)">/.exec(html)![1]!, 'base64').toString('utf8');
  const imported = /@import url\("data:text\/css;base64,([^"]+)"\)/.exec(widgetCss);
  assert.ok(imported, widgetCss);
  assert.match(Buffer.from(imported[1]!, 'base64').toString('utf8'), /font-family: 'Imported Face'/);
  // A family Google refuses stays as written for the frame's broker, with a warning.
  assert.match(html, new RegExp(`<link rel="stylesheet" href="${css2('Nope').replace(/[.?+]/g, '\\$&')}">`));
  assert.match(warnings.join('\n'), /Google Fonts refused https:\/\/fonts\.googleapis\.com\/css2\?family=Nope \(HTTP 400\)/);
});

test('previewDocument points Google Fonts captured into _import/ back at the proxy and does not embed the capture', async t => {
  const store = await localStudio(t);
  await seed(store, 'Old Capture');
  const capture = Buffer.from("@font-face{font-family:'Old Capture';src:url(_import/0123456789abcdef01234567.ttf)}");
  await store.put('fixture/css', capture);
  await store.put('fixture/ttf', FONT);
  const {createHash} = await import('node:crypto');
  const digest = (body: Uint8Array) => createHash('sha256').update(body).digest('hex');
  const source = snapshot({html: '<link rel="stylesheet" href="_import/0123456789abcdef01234568.css"><main id="ready">Ready</main>'});
  const prepared: PreparedSnapshot = {snapshot: source, warnings: [], assets: [
    {path: '_import/0123456789abcdef01234568.css', key: 'fixture/css', contentType: 'text/css', bytes: capture.byteLength, sha256: digest(capture), sourceUrl: css2('Old Capture')},
    {path: '_import/0123456789abcdef01234567.ttf', key: 'fixture/ttf', contentType: 'font/ttf', bytes: FONT.byteLength, sha256: digest(FONT), sourceUrl: fileUrl('Old Capture', 'old-capture')}
  ]};
  const {html, warnings} = await previewDocument(prepared, store, {...previewOptions, fonts: fontSource(store)});
  assert.match(dataCss(html, 'Old Capture'), /\/api\/fonts\/v1\/f\//);
  assert.deepEqual(warnings, [], 'the captured font file is neither embedded nor looked up on its own');
  assert.doesNotMatch(html, /"assetMap":\{"_import/, 'captured Google assets are not embedded');
  assert.ok(!html.includes(FONT.toString('base64').slice(0, 64)), 'the captured TTF is not embedded');
});

test('the importer keeps Google Fonts as canonical URLs instead of capturing them into _import/', async t => {
  const store = await localStudio(t);
  const prepared = await prepareSnapshot(snapshot({
    html: '<link rel="stylesheet" href="//fonts.googleapis.com/css2?family=Roboto&display=swap&foo=1"><main id="ready">Ready</main>',
    css: `@import url('https://fonts.googleapis.com/css2?family=Inter');@font-face{font-family:X;src:url(${fileUrl('X')})}`
  }), store, 'fixture');
  assert.deepEqual(prepared.assets, []);
  assert.match(prepared.snapshot.widget.html, /href="https:\/\/fonts\.googleapis\.com\/css2\?family=Roboto&amp;display=swap"/);
  assert.match(prepared.snapshot.widget.css, /@import url\("https:\/\/fonts\.googleapis\.com\/css2\?family=Inter"\)/);
  assert.match(prepared.snapshot.widget.css, new RegExp(`url\\("${fileUrl('X').replace(/[.?+]/g, '\\$&')}"\\)`));
  assert.match(prepared.warnings.join('\n'), /Google Fonts come from the Studio font proxy/);
});

// Routes -------------------------------------------------------------------------------------------

async function project(t: TestContext) {
  const store = await localStudio(t);
  const created = await createProject(store, snapshot({html: '<link id="gf" rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Static+Face"><main id="ready">Ready</main>'}), {fonts: {lookup, transport: google().transport, memory: new FontMemory()}});
  assert.equal(created.revision.status, 'ready');
  return {store, id: created.project.id, token: created.token, revisionId: created.revision.id};
}

test('the fonts route needs the editing token and enforces the per-project rate limit', async t => {
  const {id, token} = await project(t);
  const url = css2('{{font}}');
  assert.equal((await fontRequest(request(`/api/studio/projects/${id}/fonts`, {json: {url}}), params({id}))).status, 403);
  assert.equal((await fontRequest(request(`/api/studio/projects/${id}/fonts`, {json: {url}, token: 'wrong'}), params({id}))).status, 403);
  assert.equal((await fontRequest(request(`/api/studio/projects/${id}/fonts`, {json: {url, extra: 1}, token}), params({id}))).status, 422);
  const answered = await fontRequest(request(`/api/studio/projects/${id}/fonts`, {json: {url}, token}), params({id}));
  assert.equal(answered.status, 200);
  assert.equal((await answered.json()).status, 'upstream-4xx');
  while (takePreviewFontRequest(id)) { /* use up this minute */ }
  const limited = await fontRequest(request(`/api/studio/projects/${id}/fonts`, {json: {url}, token}), params({id}));
  assert.equal(limited.status, 429);
  assert.equal(takePreviewFontRequest(id, Date.now() + PREVIEW_FONT_RATE_LIMIT.windowMs + 1), true, 'the window slides');
});

test('only the saved revision without field overrides writes the font lock', async t => {
  const {store, id, token, revisionId} = await project(t);
  await seed(store, 'Runtime Face');
  const locked = async () => (await lockForRevision(store, id, revisionId)).map(entry => entry.url);
  assert.deepEqual(await locked(), [css2('Static Face')], 'prewarm pinned the static link');
  const previewOf = async (body: Record<string, unknown>) => {
    const response = await preview(request(`/api/studio/projects/${id}/preview`, {json: body, token}), params({id}));
    assert.equal(response.status, 200, await response.clone().text());
    return response.json() as Promise<{html: string; fontRevisionId?: string}>;
  };
  const saved = await previewOf({});
  assert.equal(saved.fontRevisionId, revisionId);
  dataCss(saved.html, 'Static Face');
  assert.equal((await previewOf({fieldData: {title: 'x'}})).fontRevisionId, undefined, 'a field override');
  const draft = snapshot({html: `<link rel="stylesheet" href="${css2('Draft Face')}"><main id="ready">Draft</main>`});
  await seed(store, 'Draft Face');
  const drafted = await previewOf({snapshot: draft});
  assert.equal(drafted.fontRevisionId, undefined, 'a draft');
  dataCss(drafted.html, 'Draft Face');
  assert.deepEqual(await locked(), [css2('Static Face')], 'neither the draft nor the override wrote the lock');
  const ask = async (revision?: string) => {
    const response = await fontRequest(request(`/api/studio/projects/${id}/fonts`, {json: {url: css2('Runtime Face'), sampleText: 'Hi', ...(revision ? {revisionId: revision} : {})}, token}), params({id}));
    assert.equal(response.status, 200);
    return response.json() as Promise<{status: string; css?: string; partial?: boolean}>;
  };
  const without = await ask();
  assert.equal(without.status, 'ok');
  assert.match(without.css!, /\/api\/fonts\/v1\/f\/[0-9a-f]{64}\.[0-9a-f]{16}\.woff2/);
  assert.equal(without.partial, false);
  await ask('another-revision');
  assert.deepEqual(await locked(), [css2('Static Face')], 'no revision, or a stale one, does not write the lock');
  await ask(revisionId);
  assert.deepEqual(await locked(), [css2('Runtime Face'), css2('Static Face')]);
});

test('the public font route lets one client address make 600 requests a minute per instance, then answers an uncached 429 with Retry-After', async () => {
  const memory = new FontMemory();
  let clock = 1_000_000;
  let storeCalls = 0;
  const call = (headers: Record<string, string>) => fontFileResponse(new Request(`${ORIGIN}/api/fonts/v1/f/x.woff2`, {headers}), 'x.woff2', () => {storeCalls++; throw new Error('not reached');}, memory, () => clock);
  const first = {'x-real-ip': '203.0.113.7'};
  for (let index = 0; index < 600; index++) assert.equal((await call(first)).status, 404, `request ${index + 1}`);
  const refused = await call(first);
  assert.equal(refused.status, 429);
  assert.equal(refused.headers.get('retry-after'), '60');
  assert.equal(refused.headers.get('cache-control'), 'no-store', 'the CDN never keeps a refusal');
  assert.equal(refused.headers.get('access-control-allow-origin'), '*', 'the opaque preview frame can read it');
  assert.equal((await call({'x-forwarded-for': '198.51.100.9, 10.0.0.1'})).status, 404, 'another address has its own count');
  clock += 59_500;
  assert.equal((await call(first)).headers.get('retry-after'), '1');
  clock += 500;
  assert.equal((await call(first)).status, 404, 'the window ends 60 s after its first request');
  assert.equal(storeCalls, 0, 'malformed names never reach storage, limited or not');
});

test('font route clients come from the edge headers, and the per-instance table keeps at most 10000 addresses', () => {
  const address = (headers: Record<string, string>) => clientAddress(new Request(ORIGIN, {headers}));
  assert.equal(address({'x-real-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.9'}), '203.0.113.7');
  assert.equal(address({'x-forwarded-for': ' 2001:DB8::1 , 10.0.0.1'}), '2001:db8::1');
  assert.equal(address({'x-forwarded-for': 'not an address'}), 'unknown');
  assert.equal(address({}), 'unknown');
  const memory = new FontMemory();
  for (let index = 0; index < 10_001; index++) assert.equal(takeFontFileRequest(memory, `10.0.${index >> 8}.${index & 255}`, 5_000), 0);
  assert.equal(memory.fileRequests.size, 10000, 'the oldest address makes room');
  assert.equal(memory.fileRequests.has('10.0.0.0'), false);
  assert.equal(takeFontFileRequest(memory, 'fresh', 5_000 + 60_000), 0);
  assert.equal(memory.fileRequests.size, 1, 'a full table first drops every expired window');
});
