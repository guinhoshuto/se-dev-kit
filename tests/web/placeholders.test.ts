import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import postcss from 'postcss';
import {prepareSnapshot, rewriteCss, type PublicLookup, type PublicTransport} from '../../lib/importer';
import {previewDocument} from '../../lib/preview';
import {createProject} from '../../lib/projects';
import {FontMemory, lockForRevision, prewarmGoogleFonts, staticGoogleFontUrls} from '../../lib/fonts';
import {LocalStore} from '../../lib/storage';
import type {ObjectStore, ObjectValue, WidgetSnapshot} from '../../lib/model';

// Excerpts of real store widgets (tests/fixtures/placeholders, read-only copies). Nothing here reaches the network.
const fixture = (name: string) => readFileSync(new URL(`../fixtures/placeholders/${name}`, import.meta.url), 'utf8');
const EIGHT_BIT_CSS = fixture('se-8bit-chat.widget.css');
const CUSTOM_CHAT_CSS = fixture('se-custom-chat.style.css');
const CUSTOM_CHAT_HTML = fixture('se-custom-chat.index.html');
const DREAMY_HTML = fixture('se-dreamychat.index.html');
const LAVA_HTML = fixture('se-lava-lamp.index.html');

class MemoryStore implements ObjectStore {
  items = new Map<string, ObjectValue>();
  async get(key: string) { return this.items.get(key) ?? null; }
  async put(key: string, body: Uint8Array) { this.items.set(key, {body, etag: 'v1'}); return {etag: 'v1'}; }
  async list(prefix: string) { return [...this.items.keys()].filter(key => key.startsWith(prefix)); }
  async delete(key: string) { this.items.delete(key); }
}
const snapshot = (widget: Partial<WidgetSnapshot['widget']> = {}): WidgetSnapshot => ({schemaVersion: 1, name: 'Placeholders', widget: {html: '<main id="chat"></main>', css: 'body { margin: 0 }', js: '', fields: {}, viewport: {width: 320, height: 240}, ...widget}, channel: {}, themes: [], fixtures: [], scenes: [], scenarios: [], recipes: [], assets: []});
const previewOptions = {origin: 'http://127.0.0.1:3000', sessionId: 'session', nonce: 'abcdefghijklmnop'};
const lookup: PublicLookup = async () => [{address: '8.8.8.8', family: 4}];
function upstream(handler: (url: string) => {status: number; body?: string; contentType?: string}) {
  const calls: string[] = [];
  const transport: PublicTransport = async ({url}) => {
    calls.push(url.href);
    const reply = handler(url.href);
    const body = Buffer.from(reply.body ?? '');
    return {status: reply.status, headers: {'content-length': String(body.byteLength), 'content-type': reply.contentType ?? 'text/css; charset=utf-8'}, body: (async function* () { if (body.byteLength) yield body; })(), close() {}};
  };
  return {calls, transport};
}
const woff2 = () => { const bytes = Buffer.alloc(64); bytes.write('wOF2', 0, 'latin1'); return bytes.toString('latin1'); };
const googleCss = (family: string) => `@font-face { font-family: '${family}'; font-style: normal; font-weight: 400; src: url(https://fonts.gstatic.com/s/${family.toLowerCase().replace(/\W/g, '')}/v1/a.woff2) format('woff2'); }`;
const decodeDataUrl = (url: string) => Buffer.from(url.slice(url.indexOf(',') + 1), 'base64').toString('utf8');
const pageCss = (html: string) => decodeDataUrl(/<link rel="stylesheet" href="(data:text\/css;base64,[^"]+)">/.exec(html)![1]!);
const pageScript = (html: string) => decodeDataUrl(JSON.parse(/installFrameRuntime\((\{.*?\})\);<\/script>/.exec(html)![1]!.replaceAll('\\u003c', '<')).widgetScriptUrl);

test('the fixtures reproduce the blocking bug: postcss alone cannot parse unquoted placeholders', () => {
  assert.throws(() => postcss.parse(EIGHT_BIT_CSS), /Unknown word/);
  assert.throws(() => postcss.parse(CUSTOM_CHAT_CSS), /Unknown word/);
});

test('rewriteCss parses real placeholder CSS through sentinels and round-trips it byte for byte', async () => {
  const seen: string[] = [];
  for (const css of [EIGHT_BIT_CSS, CUSTOM_CHAT_CSS]) assert.equal(await rewriteCss(css, async reference => { seen.push(reference); return reference; }), css);
  assert.deepEqual(seen, [], 'the only reference, a Google @import with {{fontFamily}}, is known only after substitution');
  // Adjacent tokens, a token inside a url(), and source that already contains the sentinel prefix.
  const tricky = '.a{margin:{{top}}{{unit}} 0;background:url(assets/{{image}}.png) , url(assets/x.png)}\n.__sws_tok_0__{width:{{w}}px;content:"__sws_tok_1__"}';
  const resolved: string[] = [];
  const output = await rewriteCss(tricky, async reference => { resolved.push(reference); return `data:${reference}`; });
  assert.deepEqual(resolved, ['assets/x.png']);
  assert.equal(output, tricky.replace('url(assets/x.png)', 'url("data:assets/x.png")'));
});

test('placeholder widgets import as ready: unquoted CSS, calc(), keywords, @import, Google <link>, and <source> with a sound-input', async () => {
  const store = await mkdtemp(join(tmpdir(), 'studio-placeholders-')).then(root => new LocalStore(root));
  const google = upstream(url => url.startsWith('https://fonts.gstatic.com/') ? {status: 200, body: woff2(), contentType: 'font/woff2'} : {status: 200, body: googleCss(new URL(url).searchParams.get('family')!.split(':')[0]!)});
  const input = snapshot({
    html: `${CUSTOM_CHAT_HTML}${DREAMY_HTML}${LAVA_HTML}`,
    css: `${EIGHT_BIT_CSS}\n${CUSTOM_CHAT_CSS}`,
    fields: {fontName: {type: 'googleFont', value: 'Roboto'}, fontFamily: {type: 'googleFont', value: 'Press Start 2P'}, alignment: {type: 'dropdown', value: 'flex-start'}, powerOnSound: {type: 'sound-input', label: 'On'}, powerOffSound: {type: 'sound-input', label: 'Off'}}
  });
  input.themes = [{schemaVersion: 1, id: 'lamp', name: 'Lamp', fieldData: {fontName: 'Archivo', powerOnSound: 'assets/on.mp3'}}];
  input.assets = [{path: 'assets/on.mp3', content: Buffer.from('ID3 fake audio').toString('base64'), encoding: 'base64', contentType: 'audio/mpeg'}];
  const created = await createProject(store, input, {fonts: {lookup, transport: google.transport, memory: new FontMemory()}});
  assert.equal(created.revision.status, 'ready', created.revision.diagnostics.join('\n'));
  const prepared = created.revision.prepared!;
  assert.equal(prepared.snapshot.widget.css, `${EIGHT_BIT_CSS}\n${CUSTOM_CHAT_CSS}`, 'widget CSS is kept exactly as written');
  assert.match(prepared.snapshot.widget.html, /<link href="https:\/\/fonts\.googleapis\.com\/css\?family=\{\{fontName\}\}:400,700" rel="stylesheet">/);
  assert.match(prepared.snapshot.widget.html, /<source src="\{\{powerOnSound\}\}">/);
  assert.doesNotMatch(prepared.snapshot.widget.html, /preconnect/);
  assert.deepEqual(prepared.assets.map(asset => asset.path), ['assets/on.mp3'], 'no placeholder reference was downloaded or captured');
  assert.equal(prepared.snapshot.themes[0]!.fieldData!.powerOnSound, 'assets/on.mp3');
  // Prewarm on save: defaults and the theme, from the <link> and the @import, canonical and deduplicated.
  const expected = [
    'https://fonts.googleapis.com/css?family=Roboto:400,700',
    'https://fonts.googleapis.com/css?family=Roboto:400,500,700',
    'https://fonts.googleapis.com/css?family=Press+Start+2P:400,700&display=swap',
    'https://fonts.googleapis.com/css?family=Archivo:400,700',
    'https://fonts.googleapis.com/css?family=Archivo:400,500,700'
  ];
  assert.deepEqual(prepared.googleFonts?.static, expected);
  assert.deepEqual((await lockForRevision(store, created.project.id, created.revision.id)).map(entry => [entry.url, entry.status]), [...expected].sort().map(url => [url, 200]));
  assert.ok(expected.every(url => google.calls.includes(url)));
});

test('prewarm runs only on save: the draft preview path prepares and previews without touching Google or the font cache', async () => {
  const store = new MemoryStore();
  const input = snapshot({html: CUSTOM_CHAT_HTML, css: CUSTOM_CHAT_CSS, fields: {fontName: {type: 'googleFont', value: 'Roboto'}, alignment: {type: 'text', value: 'center'}}});
  const prepared = await prepareSnapshot(input, store, 'draft');
  assert.equal(prepared.googleFonts, undefined);
  const page = await previewDocument(prepared, store, previewOptions);
  assert.deepEqual(await store.list('fonts/'), []);
  assert.deepEqual([...store.items.keys()].filter(key => !key.startsWith('draft/')), []);
  assert.ok(page.warnings.some(warning => /this preview has none, so text uses a fallback font/.test(warning)), page.warnings.join('\n'));
});

test('prewarm failures become diagnostics warnings and the revision stays ready', async () => {
  const store = await mkdtemp(join(tmpdir(), 'studio-placeholders-')).then(root => new LocalStore(root));
  const google = upstream(url => url.includes('Nope') ? {status: 400, body: 'bad family'} : {status: 503});
  const input = snapshot({html: '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family={{font}}">', fields: {font: {type: 'googleFont', value: 'Roboto'}}});
  input.themes = [{schemaVersion: 1, id: 'nope', name: 'Nope', fieldData: {font: 'Nope'}}];
  const created = await createProject(store, input, {fonts: {lookup, transport: google.transport, memory: new FontMemory()}});
  assert.equal(created.revision.status, 'ready');
  const diagnostics = created.revision.diagnostics.join('\n');
  assert.match(diagnostics, /Google Fonts prewarm could not cache https:\/\/fonts\.googleapis\.com\/css2\?family=Roboto/);
  assert.match(diagnostics, /Google Fonts refused https:\/\/fonts\.googleapis\.com\/css2\?family=Nope \(HTTP 400\)/);
});

test('prewarm resolves at most 8 stylesheets, never starts after its deadline, and turns thrown errors into warnings', async () => {
  const urls = Array.from({length: 10}, (_, index) => `https://fonts.googleapis.com/css2?family=Family${index}`);
  const base = {projectId: 'project', revisionId: 'revision', epoch: 'v1', userAgent: 'UA', lookup, memory: new FontMemory()};
  const capped = upstream(() => ({status: 404}));
  const warnings = await prewarmGoogleFonts(urls, {...base, store: new MemoryStore(), transport: capped.transport, deadline: Date.now() + 10_000});
  assert.equal(capped.calls.length, 8);
  assert.match(warnings[0]!, /^2 more Google Fonts stylesheets were not prewarmed/);
  const late = upstream(() => ({status: 200, body: googleCss('Late')}));
  const skipped = await prewarmGoogleFonts(urls.slice(0, 2), {...base, store: new MemoryStore(), transport: late.transport, deadline: Date.now() - 1});
  assert.equal(late.calls.length, 0);
  assert.match(skipped.join('\n'), /skipped 2 stylesheets: no time was left/);
  const broken = new MemoryStore();
  broken.get = async () => { throw new Error('storage is down'); };
  const failed = await prewarmGoogleFonts(urls.slice(0, 1), {...base, store: broken, transport: late.transport, deadline: Date.now() + 10_000});
  assert.match(failed.join('\n'), /Google Fonts prewarm failed for .*Family0: storage is down/);
});

test('static URL collection skips URLs that still hold a placeholder and keeps captured Google stylesheets', () => {
  const input = snapshot({html: '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family={{missing}}"><style>@import url("//fonts.googleapis.com/css2?family={{font}}&display=swap");</style>', css: '@import "https://fonts.googleapis.com/icon?family=Material+Icons";', fields: {font: {type: 'text', value: 'Inter'}}});
  assert.deepEqual(staticGoogleFontUrls(input, {snapshot: input, warnings: [], assets: [{path: '_import/a.css', key: 'k', contentType: 'text/css', bytes: 1, sha256: 'x', sourceUrl: 'https://fonts.googleapis.com/css?family=Lato'}]}), [
    'https://fonts.googleapis.com/css2?family=Inter&display=swap',
    'https://fonts.googleapis.com/css?family=Lato'
  ]);
  // A value that breaks the CSS still leaves its @import visible to a plain scan.
  const broken = snapshot({css: '.a { content: {{quote}} }\n@import url(\'https://fonts.googleapis.com/css2?family={{font}}\');', fields: {quote: {type: 'text', value: '"'}, font: {type: 'text', value: 'Lora'}}});
  assert.deepEqual(staticGoogleFontUrls(broken), ['https://fonts.googleapis.com/css2?family=Lora']);
});

test('previewDocument substitutes {{field}} in HTML, CSS and JS from the effective state, and embeds a substituted captured sound', async () => {
  const store = new MemoryStore();
  const input = snapshot({
    html: `<h1 id="title">{{title}}</h1>${LAVA_HTML}`,
    css: '#title::after { content: "{{title}}"; width: {{size}}px }',
    js: 'window.fromScript = "{{title}}"; window.size = {{size}};',
    fields: {title: {type: 'text', value: 'Default'}, size: {type: 'number', value: 10}, powerOnSound: {type: 'sound-input', value: 'assets/on.mp3'}, powerOffSound: {type: 'sound-input'}}
  });
  input.themes = [{schemaVersion: 1, id: 'dark', name: 'Dark', fieldData: {title: 'Theme title'}}];
  input.assets = [{path: 'assets/on.mp3', content: Buffer.from('ID3 fake audio').toString('base64'), encoding: 'base64', contentType: 'audio/mpeg'}];
  const prepared = await prepareSnapshot(input, store, 'fixture');
  const {html, warnings} = await previewDocument(prepared, store, {...previewOptions, themeId: 'dark', fieldData: {size: 24}});
  assert.match(html, /<h1 id="title">Theme title<\/h1>/);
  assert.equal(pageCss(html), '#title::after { content: "Theme title"; width: 24px }');
  assert.equal(pageScript(html), 'window.fromScript = "Theme title"; window.size = 24;');
  assert.match(html, /<source src="data:audio\/mpeg;base64,SUQzIGZha2UgYXVkaW8=">/);
  assert.match(html, /<source src="">/, 'an empty sound-input becomes an empty src, as in StreamElements');
  assert.deepEqual(warnings, []);
});

test('a value that breaks CSS parsing is a preview warning, not an error, and the CSS passes through as substituted', async () => {
  const store = new MemoryStore();
  const prepared = await prepareSnapshot(snapshot({html: '<main style="color: {{color}}">x</main>', css: '#main-container { align-items: {{alignment}}; }', fields: {alignment: {type: 'text', value: 'center'}, color: {type: 'text', value: 'red'}}}), store, 'fixture');
  const {html, warnings} = await previewDocument(prepared, store, {...previewOptions, fieldData: {alignment: 'center } .x { color: "', color: 'red; background: url('}});
  assert.equal(pageCss(html), '#main-container { align-items: center } .x { color: "; }');
  assert.match(warnings.join('\n'), /Widget CSS does not parse after \{\{field\}\} substitution/);
  assert.match(warnings.join('\n'), /An inline style attribute does not parse after \{\{field\}\} substitution/);
});

test('substituted values that add document-control elements or inline handlers are refused in the preview', async () => {
  const store = new MemoryStore();
  const prepared = await prepareSnapshot(snapshot({html: '<main>{{message}}</main>', fields: {message: {type: 'text', value: 'hello'}}}), store, 'fixture');
  for (const message of ['<meta http-equiv="refresh" content="0;url=data:text/html,x">', '<img src="x" onerror="parent.postMessage(1, `*`)">', '<base href="data:text/html,x">', '<iframe srcdoc="x"></iframe>']) {
    await assert.rejects(previewDocument(prepared, store, {...previewOptions, fieldData: {message}}), /A substituted field value adds content the Studio refuses/, message);
  }
  assert.match((await previewDocument(prepared, store, {...previewOptions, fieldData: {message: '<b>bold</b>'}})).html, /<main><b>bold<\/b><\/main>/);
});

test('without a font source, a Google link whose family comes from a placeholder previews without throwing, keeps the URL for the frame broker, and warns', async () => {
  const store = new MemoryStore();
  const prepared = await prepareSnapshot(snapshot({html: `${CUSTOM_CHAT_HTML}<p>{{unknown}}</p>`, css: CUSTOM_CHAT_CSS, fields: {fontName: {type: 'googleFont', value: 'Roboto'}, alignment: {type: 'text', value: 'center'}}}), store, 'fixture');
  const {html, warnings} = await previewDocument(prepared, store, previewOptions);
  assert.match(html, /<link href="https:\/\/fonts\.googleapis\.com\/css\?family=Roboto:400,700" rel="stylesheet">/);
  assert.match(html, /font-src data: http:\/\/127\.0\.0\.1:3000\/api\/fonts\/v1\/f\/;/, 'the preview CSP adds only the cache-only font path');
  assert.match(pageCss(html), /align-items: center;/);
  assert.match(pageCss(html), /font-family: 'Roboto';/);
  assert.match(warnings.join('\n'), /this preview has none, so text uses a fallback font \(https:\/\/fonts\.googleapis\.com\/css\?family=Roboto:400,700\)/);
  assert.match(warnings.join('\n'), /Widget HTML uses \{\{unknown\}\} with no matching field/);
  assert.match(warnings.join('\n'), /Widget CSS uses .*\{\{fontSize\}\}/, 'placeholders missing from the fields stay as written and warn');
});
