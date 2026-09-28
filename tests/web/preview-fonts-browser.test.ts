// Stage 6 of docs/plans/google-fonts.md, in a real browser: the HTML from previewDocument runs in a
// `sandbox="allow-scripts"` srcdoc iframe inside a host page that implements the editor's side of
// the bridge (`frame:font-request` to `host:font-response`) against a fake Google. The page has no
// request routing, like the editor; nothing reaches the network.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {readFile, mkdtemp, rm} from 'node:fs/promises';
import {createServer, type IncomingMessage} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {Browser, Frame, Page} from 'playwright-core';
import {detectBrowser, launchStudioBrowser} from '../../src/capture/browser';
import {FontMemory, cssForPreview, fontFileResponse, previewFontAnswer} from '../../lib/fonts';
import {prepareSnapshot, type PublicLookup, type PublicTransport} from '../../lib/importer';
import {previewDocument, previewState} from '../../lib/preview';
import {LocalStore} from '../../lib/storage';
import type {WidgetSnapshot} from '../../lib/model';
import {FONT_CACHE_EPOCH, GOOGLE_FONTS_UA} from '../../src/runtime/google-fonts-url';
import type {FontReport} from '../../src/types';

const FONT = readFileSync(new URL('../fixtures/fonts/Unbounded-400.woff2', import.meta.url));
const dist = fileURLToPath(new URL('../../dist/', import.meta.url));
const lookup: PublicLookup = async () => [{address: '8.8.8.8', family: 4}];
const css2 = (family: string) => `https://fonts.googleapis.com/css2?family=${family.replace(/ /g, '+')}`;
const fileUrl = (family: string, subset: string) => `https://fonts.gstatic.com/s/${family.toLowerCase().replace(/ /g, '')}/v1/${subset}.woff2`;

/** Fake Google: a latin and a CJK subset per family, `Nope` refused, CJK files down until `cjkUp`. */
function fakeGoogle() {
  const state = {cjkUp: false, calls: [] as string[]};
  const transport: PublicTransport = async ({url}) => {
    state.calls.push(url.href);
    let status = 200;
    let body: Buffer = FONT;
    if (url.hostname === 'fonts.googleapis.com') {
      const family = (url.searchParams.get('family') ?? '').split(':')[0]!;
      if (family === 'Nope') { status = 400; body = Buffer.from('bad family'); }
      else body = Buffer.from([['latin', 'U+0000-00FF'], ['cjk', 'U+4E00-9FFF']].map(([subset, range]) => `@font-face { font-family: '${family}'; font-style: normal; font-weight: 400; src: url(${fileUrl(family, subset!)}) format('woff2'); unicode-range: ${range}; }`).join('\n'));
    } else if (url.pathname.endsWith('/cjk.woff2') && !state.cjkUp) { status = 503; body = Buffer.from('down'); }
    return {status, headers: {'content-length': String(body.byteLength)}, body: (async function* () { yield body; })(), close() {}};
  };
  return {state, transport};
}

const widgets: Record<string, Partial<WidgetSnapshot['widget']>> = {
  runtime: {
    html: `<link id="gf" rel="stylesheet" href="${css2('Static Face')}"><link rel="stylesheet" href="${css2('Preload Face')}"><h1 id="t" style="font-family:'Runtime Face'">Studio</h1><p id="s" style="font-family:'Static Face'">Static</p><main id="ready">Ready</main>`,
    js: `window.__probe = {loads: 0, errors: 0};
const link = document.createElement('link');
link.id = 'rt'; link.rel = 'stylesheet';
link.onload = () => { window.__probe.loads += 1; };
link.onerror = () => { window.__probe.errors += 1; };
link.href = '${css2('Runtime Face')}';
document.head.append(link);`
  },
  late: {
    ready: {timeoutMs: 2000},
    html: `<h1 id="t" style="font-family:'Late Face'">Studio</h1><main id="ready">Ready</main>`,
    js: `const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = '${css2('Late Face')}'; document.head.append(link);`
  },
  cjk: {
    html: `<h1 id="t" style="font-family:'Studio Display'">Studio</h1><main id="ready">Ready</main>`,
    js: `window.__probe = {loads: 0, errors: 0};
const link = document.createElement('link');
link.rel = 'stylesheet';
link.addEventListener('load', () => { window.__probe.loads += 1; });
link.setAttribute('href', '${css2('Studio Display')}');
document.head.append(link);
window.__link = link;`
  }
};

const readBody = async (request: IncomingMessage) => { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk as Buffer); return Buffer.concat(chunks).toString('utf8'); };

async function startStudio() {
  const directory = await mkdtemp(join(tmpdir(), 'sws-preview-browser-'));
  const store = new LocalStore(directory);
  const google = fakeGoogle();
  const memory = new FontMemory();
  const fontRequests: {url: string; sampleText: string}[] = [];
  let origin = '';
  const fontOptions = (sampleText: string) => ({store, origin, epoch: FONT_CACHE_EPOCH, userAgent: GOOGLE_FONTS_UA, sampleText, deadline: Date.now() + 10_000, lookup, transport: google.transport, memory});
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url!, origin);
      if (url.pathname.startsWith('/engine/')) {
        const file = url.pathname === '/engine/version.js' ? 'version.js' : `runtime/${url.pathname.slice('/engine/runtime/'.length)}`;
        if (!/^(?:version|runtime\/[\w-]+)\.js$/.test(file)) { response.writeHead(404).end(); return; }
        response.writeHead(200, {'content-type': 'text/javascript', 'access-control-allow-origin': '*'});
        response.end(await readFile(join(dist, file)));
        return;
      }
      if (url.pathname.startsWith('/api/fonts/v1/f/')) {
        const answer = await fontFileResponse(new Request(`${origin}${request.url}`, {method: request.method}), url.pathname.split('/').pop()!, () => store, memory);
        response.writeHead(answer.status, Object.fromEntries(answer.headers));
        response.end(Buffer.from(await answer.arrayBuffer()));
        return;
      }
      if (url.pathname === '/preview') {
        const widget = widgets[url.searchParams.get('case')!]!;
        const source: WidgetSnapshot = {schemaVersion: 1, name: 'Broker', widget: {html: '', css: 'body{margin:0;font-size:20px}', js: '', fields: {}, viewport: {width: 320, height: 120}, ...widget}, channel: {}, themes: [], fixtures: [], scenes: [], scenarios: [], recipes: [], assets: []};
        const prepared = await prepareSnapshot(source, store, 'fixture');
        const options = {origin, sessionId: 'session-0123456789', nonce: 'nonce-0123456789abcdef', fonts: (font: string, {sampleText}: {sampleText: string}) => cssForPreview(font, fontOptions(sampleText))};
        const page = await previewDocument(prepared, store, options);
        response.writeHead(200, {'content-type': 'application/json'});
        response.end(JSON.stringify({html: page.html, warnings: page.warnings, state: previewState(prepared.snapshot, options), sessionId: options.sessionId, nonce: options.nonce}));
        return;
      }
      if (url.pathname === '/fonts' && request.method === 'POST') {
        const input = JSON.parse(await readBody(request)) as {url: string; sampleText: string};
        fontRequests.push(input);
        // Slow answers: one past the frame's font budget, and the subsets asked for after the first load.
        if (input.url === css2('Late Face')) await new Promise(resolve => setTimeout(resolve, 1500));
        if (/[\u4e00-\u9fff]/.test(input.sampleText)) await new Promise(resolve => setTimeout(resolve, 300));
        response.writeHead(200, {'content-type': 'application/json'});
        response.end(JSON.stringify(await previewFontAnswer(input.url, fontOptions(input.sampleText))));
        return;
      }
      if (url.pathname === '/host') {
        response.writeHead(200, {'content-type': 'text/html'});
        response.end(`<!doctype html><body><script type="module">
const data = await (await fetch('/preview' + location.search)).json();
window.__events = []; window.__warnings = data.warnings;
const iframe = document.createElement('iframe');
iframe.sandbox = 'allow-scripts'; iframe.style = 'width:320px;height:120px;border:0';
window.addEventListener('message', async (event) => {
  if (event.source !== iframe.contentWindow || event.origin !== 'null') return;
  const message = event.data;
  if (!message || message.sessionId !== data.sessionId || message.nonce !== data.nonce) return;
  window.__events.push({type: message.type, payload: message.payload});
  const post = (type, payload) => iframe.contentWindow.postMessage({protocol: message.protocol, version: message.version, sessionId: data.sessionId, nonce: data.nonce, type, payload}, '*');
  if (message.type === 'frame:booted') post('host:init', {state: data.state});
  if (message.type === 'frame:font-request') {
    const answer = await (await fetch('/fonts', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({url: message.payload.url, sampleText: message.payload.sampleText})})).json();
    post('host:font-response', {requestId: message.payload.requestId, ...answer});
  }
});
iframe.srcdoc = data.html;
document.body.append(iframe);
</script></body>`);
        return;
      }
      response.writeHead(404).end();
    } catch (error) {
      response.writeHead(500, {'content-type': 'text/plain'}).end(String(error instanceof Error ? error.stack : error));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  return {origin, google, fontRequests, close: async () => { await new Promise(resolve => server.close(resolve)); await rm(directory, {recursive: true, force: true}); }};
}

interface Opened {page: Page; frame: Frame; csp: string[]; googleRequests: string[]; lastFonts: () => Promise<FontReport>}
async function open(browser: Browser, origin: string, widget: string): Promise<Opened> {
  const page = await browser.newPage();
  const csp: string[] = [];
  const googleRequests: string[] = [];
  page.on('console', message => { if (/Content Security Policy/i.test(message.text())) csp.push(message.text()); });
  // Chromium reports a CSP-refused request too; only one that got a response reached the network.
  page.on('requestfinished', request => { if (/fonts\.(?:googleapis|gstatic)\.com/.test(request.url())) googleRequests.push(request.url()); });
  page.on('response', response => { if (/fonts\.(?:googleapis|gstatic)\.com/.test(response.url())) googleRequests.push(response.url()); });
  await page.goto(`${origin}/host?case=${widget}`);
  await page.waitForFunction(() => (window as unknown as {__events: {type: string}[]}).__events?.some(event => event.type === 'frame:widget-ready' || event.type === 'frame:error'), undefined, {timeout: 20_000});
  const errors = await page.evaluate(() => (window as unknown as {__events: {type: string; payload: unknown}[]}).__events.filter(event => event.type === 'frame:error'));
  assert.deepEqual(errors, []);
  const frame = page.frames().find(item => item !== page.mainFrame())!;
  const lastFonts = () => page.evaluate(() => (window as unknown as {__events: {type: string; payload: {report: FontReport}}[]}).__events.filter(event => event.type === 'frame:fonts').at(-1)!.payload.report);
  return {page, frame, csp, googleRequests, lastFonts};
}

const settle = (frame: Frame) => frame.evaluate(() => Promise.race([
  (window as unknown as {__SE_WIDGET_STUDIO__: {settle: () => Promise<unknown>}}).__SE_WIDGET_STUDIO__.settle().then(report => ({settled: true, report})),
  new Promise(resolve => setTimeout(() => resolve({settled: false}), 8000))
])) as Promise<{settled: boolean; report?: FontReport}>;
const probe = (frame: Frame) => frame.evaluate(() => (window as unknown as {__probe: {loads: number; errors: number}}).__probe);
const face = (report: FontReport | undefined, family: string) => report?.families.find(entry => entry.family === family);

test('[browser] the preview broker loads runtime and static Google Fonts through the editor bridge, in a real sandboxed iframe', {timeout: 90_000}, async t => {
  if (!(await detectBrowser()).executablePath) { t.skip('No compatible local Chromium executable is installed; the Studio must not download one implicitly.'); return; }
  const studio = await startStudio();
  const {browser} = await launchStudioBrowser({});
  try {
    const {page, frame, csp, googleRequests, lastFonts} = await open(browser, studio.origin, 'runtime');
    const ready = await lastFonts();
    assert.equal(face(ready, 'Runtime Face')?.status, 'loaded', JSON.stringify(ready));
    assert.equal(face(ready, 'Static Face')?.status, 'loaded', JSON.stringify(ready));
    // A family only its static link names is still preloaded and reported under the Google URL.
    assert.deepEqual(face(ready, 'Preload Face'), {family: 'Preload Face', weight: '400', style: 'normal', sources: ['google'], url: css2('Preload Face'), status: 'loaded'});
    assert.deepEqual(csp, [], 'no securitypolicyviolation for brokered or server-resolved stylesheets');
    const hrefs = await frame.evaluate(() => ({
      runtime: (document.getElementById('rt') as HTMLLinkElement).href,
      runtimeAttribute: document.getElementById('rt')!.getAttribute('href'),
      staticHref: (document.getElementById('gf') as HTMLLinkElement).href
    }));
    assert.deepEqual(hrefs, {runtime: css2('Runtime Face'), runtimeAttribute: css2('Runtime Face'), staticHref: css2('Static Face')}, 'the widget reads its Google URLs back');
    assert.deepEqual(await probe(frame), {loads: 1, errors: 0});
    assert.deepEqual(studio.fontRequests.map(item => item.url), [css2('Runtime Face')], 'the static link was resolved on the server');

    // The same href again: exactly one more load, and no new request.
    await frame.evaluate(() => { const link = document.getElementById('rt') as HTMLLinkElement; link.href = link.href; });
    assert.equal((await settle(frame)).settled, true);
    await page.waitForTimeout(400);
    assert.deepEqual(await probe(frame), {loads: 2, errors: 0});
    assert.equal(studio.fontRequests.length, 1);

    // A double swap ends on the last href without hanging readiness.
    await frame.evaluate(({other, runtime}) => { const link = document.getElementById('rt') as HTMLLinkElement; link.href = other; link.href = runtime; }, {other: css2('Other Face'), runtime: css2('Runtime Face')});
    assert.equal((await settle(frame)).settled, true);
    await page.waitForTimeout(400);
    assert.deepEqual(await probe(frame), {loads: 3, errors: 0});
    // A real swap: the new family loads once.
    await frame.evaluate(other => { const link = document.getElementById('rt') as HTMLLinkElement; link.href = other; (document.getElementById('t') as HTMLElement).style.fontFamily = "'Other Face'"; }, css2('Other Face'));
    const swapped = await settle(frame);
    assert.equal(swapped.settled, true);
    assert.equal(face(swapped.report, 'Other Face')?.status, 'loaded', JSON.stringify(swapped.report));
    assert.deepEqual(await probe(frame), {loads: 4, errors: 0});

    // A family Google refuses: an error event, and the report says why.
    await frame.evaluate(nope => { const link = document.getElementById('rt') as HTMLLinkElement; link.href = nope; (document.getElementById('t') as HTMLElement).style.fontFamily = "'Nope'"; }, css2('Nope'));
    const refused = await settle(frame);
    assert.equal(refused.settled, true);
    assert.deepEqual(await probe(frame), {loads: 4, errors: 1});
    assert.deepEqual(refused.report?.failedStylesheets, [{href: css2('Nope'), reason: 'upstream-4xx'}]);
    assert.equal(face(refused.report, 'Nope')?.reason, 'upstream-4xx');
    assert.deepEqual(csp, []);
    assert.deepEqual(googleRequests, []);

    // A link inserted as markup never passes through the setters: the CSP refuses it first, then the broker loads it.
    await frame.evaluate(inner => { document.head.insertAdjacentHTML('beforeend', `<link id="ih" rel="stylesheet" href="${inner}">`); (document.getElementById('s') as HTMLElement).style.fontFamily = "'Inner Face'"; }, css2('Inner Face'));
    const inner = await settle(frame);
    assert.equal(inner.settled, true);
    assert.equal(face(inner.report, 'Inner Face')?.status, 'loaded', JSON.stringify(inner.report));
    assert.equal(await frame.evaluate(() => (document.getElementById('ih') as HTMLLinkElement).href), css2('Inner Face'));
    assert.deepEqual(googleRequests, [], 'nothing in the iframe reached Google');
    assert.ok(csp.some(message => message.includes(css2('Inner Face'))), 'the markup link hit the CSP first, as documented');
    await page.close();
  } finally {
    await browser.close();
    await studio.close();
  }
});

test('[browser] text that arrives after the first load gets its subsets without touching the widget\'s link again', {timeout: 60_000}, async t => {
  if (!(await detectBrowser()).executablePath) { t.skip('No compatible local Chromium executable is installed; the Studio must not download one implicitly.'); return; }
  const studio = await startStudio();
  const {browser} = await launchStudioBrowser({});
  try {
    const {page, frame, lastFonts} = await open(browser, studio.origin, 'cjk');
    assert.equal(face(await lastFonts(), 'Studio Display')?.status, 'loaded');
    assert.deepEqual(await probe(frame), {loads: 1, errors: 0});
    assert.equal(studio.fontRequests.length, 1);
    // The CJK subset could not be cached for the first answer; now Google has it.
    studio.google.state.cjkUp = true;
    await frame.evaluate(() => { document.getElementById('t')!.textContent = '漢字 Studio'; });
    const settled = await settle(frame);
    assert.equal(settled.settled, true);
    assert.equal(studio.fontRequests.length, 2);
    assert.equal(studio.fontRequests[1]!.url, css2('Studio Display'));
    assert.match(studio.fontRequests[1]!.sampleText, /漢/);
    assert.ok(studio.google.state.calls.includes(fileUrl('Studio Display', 'cjk')));
    // settle() waited for the subsets: they are in place as soon as it returns.
    const after = await frame.evaluate(() => ({
      subsets: document.querySelectorAll('style[data-sws-font-subsets]').length,
      href: (window as unknown as {__link: HTMLLinkElement}).__link.getAttribute('href'),
      cjkFaces: Array.from(document.fonts).filter(item => item.family.includes('Studio Display') && item.unicodeRange.includes('4E00')).length
    }));
    assert.deepEqual(after, {subsets: 1, href: css2('Studio Display'), cjkFaces: 1});
    await page.waitForTimeout(400);
    assert.deepEqual(await probe(frame), {loads: 1, errors: 0}, 'the widget\'s onload ran exactly once');
    await page.close();
  } finally {
    await browser.close();
    await studio.close();
  }
});

test('[browser] an answer that arrives after the preview became ready updates the font report', {timeout: 60_000}, async t => {
  if (!(await detectBrowser()).executablePath) { t.skip('No compatible local Chromium executable is installed; the Studio must not download one implicitly.'); return; }
  const studio = await startStudio();
  const {browser} = await launchStudioBrowser({});
  try {
    const {page, lastFonts} = await open(browser, studio.origin, 'late');
    const first = await lastFonts();
    assert.equal(face(first, 'Late Face')?.status, 'fallback', 'the frame\'s budget (1 s here) ends before the answer');
    assert.equal(first.complete, false);
    await page.waitForFunction(() => {
      const reports = (window as unknown as {__events: {type: string; payload: {report: FontReport}}[]}).__events.filter(event => event.type === 'frame:fonts');
      return reports.at(-1)?.payload.report.families.some(entry => entry.family === 'Late Face' && entry.status === 'loaded');
    }, undefined, {timeout: 10_000});
    await page.close();
  } finally {
    await browser.close();
    await studio.close();
  }
});
