import {createHash} from 'node:crypto';
import {lookup} from 'node:dns/promises';
import {request} from 'node:https';
import {isIP} from 'node:net';
import {posix} from 'node:path';
import {parse, serialize, type DefaultTreeAdapterMap} from 'parse5';
import postcss from 'postcss';
import type {JsonValue} from '../src/types';
import {normalizeFields} from '../src/config/fields';
import {unknownSampleMediaText} from '../src/config/sample-media';
import {inspectSensitive} from '../src/validation/privacy';
import type {ObjectStore, PreparedSnapshot, StoredAsset, WidgetSnapshot} from './model';
import {claimsSampleMediaScheme, collectSampleMediaReferences} from '../src/studio-ui/sample-media';
import {deployedSampleMedia, type SampleMediaSource} from './sample-media';
import {hasPlaceholder, refusedHtmlElement} from '../src/config/placeholders';
import {canonicalGoogleFontsUrl} from '../src/runtime/google-fonts-url';
import {widgetRouteKey} from '../src/shared/widget-route';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];
const MAX_ASSET_BYTES = 100 * 1024 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_ASSETS = 128;
const RESERVED = new Set(['widget.html', 'widget.css', 'widget.js', 'fields.json']);
const mimeTypes: Record<string, string> = {'.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav'};
export const sha256 = (body: Uint8Array | string): string => createHash('sha256').update(body).digest('hex');

export function safeAssetPath(value: string): string {
  if (!value || value.length > 240 || /[\\\x00-\x20?#:%]/.test(value) || value.startsWith('/') || value.split('/').some(part => part === '..' || part === '.' || !part)) throw new Error('Asset paths must be relative, normalized, and contained in the project.');
  if (RESERVED.has(value) || value.startsWith('.')) throw new Error(`Reserved asset path: ${value}`);
  return value;
}

/** Deny special-use addresses, including IPv4-mapped IPv6. Every DNS answer must be public. */
export function isPublicAddress(raw: string): boolean {
  const address = raw.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(address) === 4) {
    const [a = 0, b = 0, c = 0] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  // A conservative public IPv6 subset avoids mapped, NAT64, local, and special ranges.
  if (isIP(address) !== 6 || !/^[23][0-9a-f]{3}:/.test(address)) return false;
  const [first = 0, second = 0] = address.split(':').slice(0, 2).map(part => Number.parseInt(part || '0', 16));
  return first !== 0x2002 && first !== 0x3fff && !(first === 0x2001 && (second <= 0x1ff || second === 0xdb8));
}

export interface PublicAddress {address: string; family: 4 | 6}
/** Resolves a hostname to every address it has. Injectable so tests never touch DNS. */
export type PublicLookup = (hostname: string) => Promise<PublicAddress[]>;
export interface PublicTransportResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Uint8Array>;
  close(): void;
}
/**
 * One GET to one already-validated address. It must never resolve the hostname again, and it
 * rejects only when no response arrived (connection-level failure), so the caller may try the
 * next address. Injectable so tests never touch the network.
 */
export type PublicTransport = (request: {url: URL; address: PublicAddress; headers: Record<string, string>; signal: AbortSignal; idleTimeoutMs: number}) => Promise<PublicTransportResponse>;
export interface FetchPublicAssetOptions {
  /** Redirects followed before failing. Default 4. `0` makes every 3xx an error. */
  maxRedirects?: number;
  /** Absolute epoch milliseconds for the whole fetch, redirects and retries included. Default now + 20 s. */
  deadline?: number;
  /** Replaces the default request headers. Client headers are never forwarded. */
  headers?: Record<string, string>;
  /** Maximum body size. Default 10 MB. */
  maxBytes?: number;
  /** Exact lowercase hostnames allowed on every hop. Default: any public host. */
  allowedHosts?: readonly string[];
  /** Try IPv4 answers before IPv6 ones. */
  preferIpv4?: boolean;
  lookup?: PublicLookup;
  transport?: PublicTransport;
}
export interface PublicAsset {body: Buffer; contentType: string; status: number; url: string; address: string}
export type PublicFetchFailure = 'status' | 'redirect' | 'size' | 'truncated' | 'network' | 'deadline' | 'address' | 'url';
/** Typed transport failure. `status` is set when upstream answered with a non-200 status. */
export class PublicFetchError extends Error {
  constructor(readonly kind: PublicFetchFailure, message: string, readonly status?: number) { super(message); this.name = 'PublicFetchError'; }
}

const DEFAULT_FETCH_HEADERS = {'User-Agent': 'SE-Widget-Studio/0.2', Accept: '*/*'};
const IDLE_TIMEOUT_MS = 15_000;

const systemLookup: PublicLookup = async hostname => (await lookup(hostname, {all: true})).map(answer => ({address: answer.address, family: answer.family === 6 ? 6 : 4}));

const httpsTransport: PublicTransport = ({url, address, headers, signal, idleTimeoutMs}) => new Promise((resolve, reject) => {
  const req = request(url, {method: 'GET', family: address.family, headers, signal, lookup: (_host, _options, callback) => callback(null, address.address, address.family)}, response => {
    resolve({status: response.statusCode ?? 0, headers: response.headers, body: response, close: () => response.destroy()});
  });
  req.setTimeout(idleTimeoutMs, () => req.destroy(new PublicFetchError('network', 'Remote asset timed out.')));
  req.on('error', reject);
  req.end();
});

const header = (headers: PublicTransportResponse['headers'], name: string): string | undefined => { const value = headers[name]; return Array.isArray(value) ? value[0] : value; };

/**
 * Bounded GET of a public HTTPS resource. Every DNS answer must be public; the validated addresses
 * are tried in turn (a connection failure moves to the next one), and the one used is returned.
 * `deadline` bounds the whole fetch; the 15 s socket timeout bounds inactivity.
 */
export async function fetchPublicAsset(input: string, options: FetchPublicAssetOptions = {}, redirects = 0): Promise<PublicAsset> {
  const {maxRedirects = 4, deadline = Date.now() + 20_000, maxBytes = MAX_FILE_BYTES} = options;
  const tooLarge = maxBytes === MAX_FILE_BYTES ? 'Remote asset exceeds the 10 MB per-file limit.' : `Remote asset exceeds the ${maxBytes}-byte limit.`;
  if (redirects > maxRedirects) throw new PublicFetchError('redirect', maxRedirects === 0 ? 'Remote asset redirected; redirects are not allowed.' : 'Remote asset exceeded the redirect limit.');
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw new PublicFetchError('url', 'Remote assets require public HTTPS URLs without credentials or custom ports.');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (options.allowedHosts && !options.allowedHosts.includes(hostname.toLowerCase())) throw new PublicFetchError('url', `Remote host ${hostname} is not allowed here.`);
  if (Date.now() >= deadline) throw new PublicFetchError('deadline', 'Asset preparation exceeded its time budget.');
  let dnsTimer: ReturnType<typeof setTimeout> | undefined;
  const literal = isIP(hostname);
  const answers: PublicAddress[] = literal ? [{address: hostname, family: literal === 6 ? 6 : 4}] : await Promise.race([(options.lookup ?? systemLookup)(hostname), new Promise<never>((_resolve, reject) => { dnsTimer = setTimeout(() => reject(new PublicFetchError('network', 'Remote DNS lookup timed out.')), Math.min(5000, deadline - Date.now())); })]).finally(() => { if (dnsTimer) clearTimeout(dnsTimer); });
  if (!answers.length || answers.some(answer => !isPublicAddress(answer.address))) throw new PublicFetchError('address', 'Remote asset resolved to a private or special-use address.');
  const ordered = options.preferIpv4 ? [...answers.filter(answer => answer.family === 4), ...answers.filter(answer => answer.family !== 4)] : answers;
  const controller = new AbortController();
  const deadlineError = new PublicFetchError('deadline', 'Asset preparation exceeded its time budget.');
  const deadlineTimer = setTimeout(() => controller.abort(deadlineError), Math.max(1, deadline - Date.now()));
  try {
    let response: PublicTransportResponse | undefined;
    let used: PublicAddress | undefined;
    let lastError: unknown;
    for (const address of ordered) {
      if (controller.signal.aborted) break;
      try { response = await (options.transport ?? httpsTransport)({url, address, headers: {...(options.headers ?? DEFAULT_FETCH_HEADERS)}, signal: controller.signal, idleTimeoutMs: IDLE_TIMEOUT_MS}); used = address; break; }
      catch (error) { lastError = error; }
    }
    if (controller.signal.aborted) { response?.close(); throw deadlineError; }
    if (!response || !used) throw lastError instanceof PublicFetchError ? lastError : new PublicFetchError('network', `Remote asset could not be reached: ${lastError instanceof Error ? lastError.message : 'connection failed'}.`);
    const status = response.status;
    const location = header(response.headers, 'location');
    if (status >= 300 && status < 400 && location) {
      response.close();
      if (maxRedirects === 0) throw new PublicFetchError('redirect', 'Remote asset redirected; redirects are not allowed.', status);
      clearTimeout(deadlineTimer);
      return await fetchPublicAsset(new URL(location, url).href, {...options, deadline}, redirects + 1);
    }
    if (status !== 200) { response.close(); throw new PublicFetchError('status', `Remote asset returned HTTP ${status}.`, status); }
    const declared = header(response.headers, 'content-length');
    const expected = declared === undefined ? undefined : Number(declared);
    if (expected !== undefined && expected > maxBytes) { response.close(); throw new PublicFetchError('size', tooLarge); }
    const chunks: Buffer[] = [];
    let bytes = 0;
    try {
      for await (const chunk of response.body) {
        if (controller.signal.aborted) throw deadlineError;
        bytes += chunk.byteLength;
        if (bytes > maxBytes) throw new PublicFetchError('size', tooLarge);
        chunks.push(Buffer.from(chunk));
      }
    } catch (error) {
      response.close();
      if (error instanceof PublicFetchError) throw error;
      if (controller.signal.aborted) throw deadlineError;
      throw new PublicFetchError('network', error instanceof Error ? error.message : 'Remote asset stream failed.');
    }
    if (controller.signal.aborted) throw deadlineError;
    if (expected !== undefined && Number.isSafeInteger(expected) && bytes !== expected) throw new PublicFetchError('truncated', `Remote asset body has ${bytes} bytes but Content-Length declared ${expected}.`);
    return {body: Buffer.concat(chunks), contentType: String(header(response.headers, 'content-type') ?? 'application/octet-stream').split(';')[0]!, status, url: url.href, address: used.address};
  } finally { clearTimeout(deadlineTimer); }
}

export function assertSafeSnapshot(snapshot: WidgetSnapshot, overrides?: JsonValue): void {
  const findings: string[] = [];
  inspectSensitive(normalizeFields(snapshot.widget.fields).defaults, 'fields', findings);
  inspectSensitive(snapshot.channel, 'channel', findings);
  for (const [kind, items] of Object.entries({themes: snapshot.themes, fixtures: snapshot.fixtures, scenes: snapshot.scenes, scenarios: snapshot.scenarios})) inspectSensitive(items as unknown as JsonValue, kind, findings);
  if (overrides) inspectSensitive(overrides, 'overrides', findings);
  // Code is not evaluated here; this rejects known live endpoints without echoing source or secrets.
  if (/(?:(?:api|kvstore)\.streamelements\.com|streamelements\.com\/(?:api|oauth|hooks?))/i.test(JSON.stringify(snapshot))) findings.push('source');
  if (findings.length) throw new Error('Studio inputs contain credentials, cookies, webhooks, or live StreamElements API data. Use synthetic public-safe inputs only.');
}

export function elements(root: Node): Element[] {
  const found: Element[] = [];
  const visit = (node: Node) => { if ('tagName' in node) found.push(node); if ('childNodes' in node) node.childNodes.forEach(visit); if ('content' in node) visit(node.content); };
  visit(root); return found;
}
export const attribute = (node: Element, name: string): string | undefined => node.attrs.find(attr => attr.name === name)?.value;
export function setAttribute(node: Element, name: string, value: string): void { const attr = node.attrs.find(item => item.name === name); if (attr) attr.value = value; else node.attrs.push({name, value}); }
export function textContent(node: Element): string { return node.childNodes.map(child => child.nodeName === '#text' ? (child as DefaultTreeAdapterMap['textNode']).value : '').join(''); }
export function setText(node: Element, value: string): void { node.childNodes = [{nodeName: '#text', value, parentNode: node}]; }
function remove(node: Element): void { if (node.parentNode) node.parentNode.childNodes = node.parentNode.childNodes.filter(child => child !== node); }

/**
 * Swaps each `{{field}}` for a sentinel that is a valid CSS identifier, so postcss parses widget CSS
 * that uses unquoted placeholders (`gap: {{msgSpacing}}px`, `align-items: {{alignment}}`).
 * `restore` puts the original placeholder text back, byte for byte.
 */
export function protectPlaceholders(css: string): {text: string; restore: (value: string) => string} {
  let prefix = '__sws_tok';
  while (css.includes(prefix)) prefix += 'x';
  const tokens: string[] = [];
  const text = css.replace(/\{\{\s*[\w.-]+\s*\}\}/g, match => `${prefix}_${tokens.push(match) - 1}__`);
  const pattern = new RegExp(`${prefix}_(\\d+)__`, 'g');
  return {text, restore: value => tokens.length ? value.replace(pattern, (match, index: string) => tokens[Number(index)] ?? match) : value};
}

/**
 * Rewrites every `url()` and `@import` through `resolve`. References that still hold a `{{field}}`
 * are left exactly as written: they are known only after substitution.
 */
export async function rewriteCss(css: string, resolve: (url: string) => Promise<string>): Promise<string> {
  const {text, restore} = protectPlaceholders(css);
  const tree = postcss.parse(text);
  const declarations: {value: string}[] = [];
  tree.walkDecls(declaration => { declarations.push(declaration); });
  const imports: {params: string}[] = [];
  tree.walkAtRules('import', rule => { imports.push(rule); });
  for (const declaration of declarations) {
    const matches = [...declaration.value.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]+))\s*\)/gi)];
    for (const match of matches) {
      const reference = restore(match[1] ?? match[2] ?? match[3] ?? '');
      if (hasPlaceholder(reference)) continue;
      declaration.value = declaration.value.replace(match[0], `url(${JSON.stringify(await resolve(reference))})`);
    }
  }
  for (const rule of imports) {
    const match = /^(?:url\(\s*)?(?:"([^"]*)"|'([^']*)'|([^\s)]+))\s*\)?(.*)$/i.exec(rule.params);
    if (!match) throw new Error('Unsupported CSS import syntax.');
    const reference = restore(match[1] ?? match[2] ?? match[3] ?? '');
    if (hasPlaceholder(reference)) continue;
    rule.params = `url(${JSON.stringify(await resolve(reference))})${match[4] ?? ''}`;
  }
  return restore(tree.toString());
}

/**
 * Validates built-in `sws-sample:` references and pins each to the deployed SHA-256. They stay
 * literal in the revision and never become captured assets, uploads, or Blob objects.
 */
export async function pinSampleMedia(snapshot: WidgetSnapshot, sampleMedia: SampleMediaSource): Promise<Record<string, string>> {
  const inFields = collectSampleMediaReferences(snapshot.widget.fields);
  if (inFields.length) throw new Error(`Sample media references cannot be saved as FIELDS defaults: ${inFields[0]}. StreamElements does not understand them; set them in a theme, fixture, or scene.`);
  const references = collectSampleMediaReferences({channel: snapshot.channel, themes: snapshot.themes, fixtures: snapshot.fixtures, scenes: snapshot.scenes, scenarios: snapshot.scenarios, recipes: snapshot.recipes}).sort();
  const pins: Record<string, string> = {};
  if (!references.length) return pins;
  const catalog = await sampleMedia();
  for (const reference of references) {
    const entry = catalog.entry(reference);
    if (!entry) throw new Error(`${unknownSampleMediaText(reference, catalog.retiredOn(reference))}. See sample-media/manifest.json for the available references.`);
    pins[reference] = entry.sha256;
  }
  return pins;
}

export async function prepareSnapshot(source: WidgetSnapshot, store: ObjectStore, prefix: string, sampleMedia: SampleMediaSource = deployedSampleMedia): Promise<PreparedSnapshot> {
  assertSafeSnapshot(source);
  const deadline = Date.now() + 45_000;
  const snapshot = structuredClone(source);
  const samplePins = await pinSampleMedia(snapshot, sampleMedia);
  const assets = new Map<string, {body: Buffer; contentType: string; sourceUrl?: string}>();
  const remotePaths = new Map<string, string>();
  const completed = new Set<string>();
  const visiting = new Set<string>();
  let total = 0;
  const add = (path: string, body: Buffer, contentType: string, sourceUrl?: string) => {
    safeAssetPath(path);
    if (assets.has(path)) throw new Error(`Duplicate asset path: ${path}`);
    if (body.byteLength > MAX_FILE_BYTES || (total += body.byteLength) > MAX_ASSET_BYTES || assets.size >= MAX_ASSETS) throw new Error('Asset budget exceeded (10 MB per file, 100 MB and 128 files per revision).');
    if (contentType === 'text/html' || contentType === 'application/xhtml+xml') throw new Error('HTML dependencies are not supported. Submit HTML as widget source.');
    assets.set(path, {body, contentType, ...(sourceUrl ? {sourceUrl} : {})});
    if (sourceUrl) remotePaths.set(sourceUrl, path);
  };
  for (const asset of snapshot.assets) {
    safeAssetPath(asset.path);
    if (asset.uploadId) throw new Error('Uploaded assets must be resolved before preparation.');
    if (asset.url !== undefined && asset.content !== undefined) throw new Error('An asset must use either a URL or content, not both.');
    if (asset.url) {
      const fetched = await fetchPublicAsset(asset.url, {deadline});
      add(asset.path, fetched.body, asset.contentType ?? fetched.contentType, asset.url);
    } else if (asset.content !== undefined) {
      if (asset.encoding === 'base64' && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(asset.content)) throw new Error('Invalid base64 asset content.');
      add(asset.path, Buffer.from(asset.content, asset.encoding === 'base64' ? 'base64' : 'utf8'), asset.contentType ?? mimeTypes[posix.extname(asset.path).toLowerCase()] ?? 'application/octet-stream');
    } else throw new Error(`Asset has no content: ${asset.path}`);
  }
  const resolveReference = async (reference: string, base = '', destination = ''): Promise<string> => {
    if (!reference || reference.startsWith('#') || reference.startsWith('data:')) return reference;
    // Known only after substitution, per preview or capture; neither downloaded nor treated as a local path.
    if (hasPlaceholder(reference)) return reference;
    if (claimsSampleMediaScheme(reference)) throw new Error(`Sample media references are supported only in catalog values and scene backgrounds, not in widget HTML or CSS: ${reference}`);
    if (/^(?:blob:|javascript:|file:|http:)/i.test(reference)) throw new Error('Only captured project assets, data URLs, and public HTTPS imports are supported.');
    let path: string;
    const remote = /^https:\/\//i.test(reference) || reference.startsWith('//') || base.startsWith('https:');
    if (remote) {
      const url = new URL(reference, base || 'https://invalid.invalid/').href;
      // Google Fonts come from the Studio's font proxy in previews and jobs: keep the canonical URL.
      // URLs the proxy cannot serve (`/icon`, `text=`) are still captured as before.
      const google = canonicalGoogleFontsUrl(url);
      if (google.ok) return google.url;
      const existing = remotePaths.get(url);
      if (existing) path = existing;
      else {
        const fetched = await fetchPublicAsset(url, {deadline});
        const originalExtension = posix.extname(new URL(url).pathname).toLowerCase();
        const extension = mimeTypes[originalExtension] ? originalExtension : Object.entries(mimeTypes).find(([, type]) => type === fetched.contentType)?.[0];
        if (!extension) throw new Error('Remote dependency has an unsupported content type.');
        path = `_import/${sha256(url).slice(0, 24)}${extension}`;
        add(path, fetched.body, fetched.contentType, url);
      }
    } else {
      const clean = reference.split(/[?#]/, 1)[0]!;
      const localKey = widgetRouteKey(clean);
      if (localKey) throw new Error(`${reference} is a local Studio URL. Use the widget-relative path ${localKey}, which local runs accept too.`);
      if (clean.startsWith('/')) throw new Error(`Absolute local asset paths are not supported: ${reference}`);
      path = posix.normalize(posix.join(base ? posix.dirname(base) : '', clean));
      safeAssetPath(path);
      if (!assets.has(path)) throw new Error(`Missing asset: ${path}. Include it in assets or use a public HTTPS URL.`);
    }
    await prepareAsset(path);
    return destination ? posix.relative(posix.dirname(destination), path) : path;
  };
  const prepareAsset = async (path: string): Promise<void> => {
    if (completed.has(path)) return;
    if (visiting.has(path)) throw new Error(`Cyclic stylesheet dependency: ${path}`);
    visiting.add(path);
    const asset = assets.get(path)!;
    if (asset.contentType === 'text/css' || posix.extname(path) === '.css') asset.body = Buffer.from(await rewriteCss(asset.body.toString('utf8'), ref => resolveReference(ref, asset.sourceUrl ?? path, path)));
    visiting.delete(path); completed.add(path);
  };
  const document = parse(snapshot.widget.html);
  for (const node of elements(document)) {
    const refused = refusedHtmlElement(node.tagName, node.attrs);
    if (refused) throw new Error(refused);
    if (attribute(node, 'srcset')) throw new Error('Responsive srcset imports are unsupported. Use a single captured src asset.');
    if (node.tagName === 'script') {
      const type = attribute(node, 'type')?.toLowerCase();
      if (type && !['text/javascript', 'application/javascript'].includes(type)) throw new Error('Only classic JavaScript script tags are supported; modules and import maps are not imported.');
      const src = attribute(node, 'src');
      if (src && /^(?:\.\/)?(?:widget|script)\.js$/.test(src.split(/[?#]/, 1)[0]!)) { remove(node); continue; }
      if (src) setAttribute(node, 'data-sws-src', await resolveReference(src));
      setAttribute(node, 'type', 'application/x-sws-classic');
      node.attrs = node.attrs.filter(attr => !['src', 'integrity', 'crossorigin', 'async', 'defer', 'nonce'].includes(attr.name));
      continue;
    }
    if (node.tagName === 'link') {
      const rel = attribute(node, 'rel');
      if (rel !== 'stylesheet') { remove(node); continue; }
      const href = attribute(node, 'href');
      if (href && /^(?:\.\/)?(?:widget|style)\.css$/.test(href.split(/[?#]/, 1)[0]!)) { remove(node); continue; }
      if (href) setAttribute(node, 'href', await resolveReference(href));
    }
    for (const name of ['src', 'poster']) { const value = attribute(node, name); if (value) setAttribute(node, name, await resolveReference(value)); }
    for (const attr of node.attrs) if (/^(?:javascript:|http:|https:|\/\/)/i.test(attr.value) && attr.name === 'href' && node.tagName !== 'link') throw new Error('External navigation is unavailable in isolated previews.');
    const style = attribute(node, 'style');
    if (style) setAttribute(node, 'style', await rewriteCss(style, ref => resolveReference(ref)));
    if (node.tagName === 'style') setText(node, await rewriteCss(textContent(node), ref => resolveReference(ref)));
  }
  snapshot.widget.html = serialize(document);
  snapshot.widget.css = await rewriteCss(snapshot.widget.css, ref => resolveReference(ref));
  const mediaFields = new Set(normalizeFields(snapshot.widget.fields).fields.filter(field => ['image-input', 'video-input', 'sound-input'].includes(field.type)).map(field => field.id));
  // A media value is one reference or, for a `multiple` field, an array of them; each is captured and
  // validated alike, in order. Sample references stay literal: they were validated and pinned above.
  const resolveMediaItem = async (item: JsonValue): Promise<JsonValue> => typeof item === 'string' && item && !claimsSampleMediaScheme(item) ? await resolveReference(item) : item;
  const resolveMedia = async (value: JsonValue): Promise<JsonValue> => {
    if (!Array.isArray(value)) return resolveMediaItem(value);
    const resolved: JsonValue[] = [];
    for (const item of value) resolved.push(await resolveMediaItem(item));
    return resolved;
  };
  const rewriteFieldData = async (data: Record<string, JsonValue>) => { for (const key of mediaFields) { const value = data[key]; if (value !== undefined) data[key] = await resolveMedia(value); } };
  const raw = snapshot.widget.fields;
  const fields = raw && typeof raw === 'object' && !Array.isArray(raw) && 'fields' in raw ? raw.fields : raw;
  if (fields && typeof fields === 'object') for (const [key, value] of Object.entries(fields)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const id = Array.isArray(fields) ? String(value.id ?? value.name ?? key) : key;
    if (mediaFields.has(id)) for (const property of ['value', 'default']) { const media = value[property]; if (media !== undefined) value[property] = await resolveMedia(media); }
  }
  for (const item of [...snapshot.themes, ...snapshot.fixtures, ...snapshot.scenes]) if (item.fieldData) await rewriteFieldData(item.fieldData);
  const backgrounds = [...snapshot.scenes.flatMap(scene => scene.background ? [scene.background] : []), ...snapshot.recipes.flatMap(recipe => recipe.matrix?.backgrounds ?? [])];
  for (const background of backgrounds) {
    if (!background.image || claimsSampleMediaScheme(background.image)) continue;
    const reference = await resolveReference(background.image);
    const contentType = reference.startsWith('data:') ? /^data:([^;,]+)/i.exec(reference)?.[1] : assets.get(reference)?.contentType;
    if (!contentType || !/^image\/(?:png|jpeg|gif|webp|avif|svg\+xml)$/i.test(contentType)) throw new Error('Scene backgrounds must use a captured PNG, JPEG, GIF, WebP, AVIF, or SVG image.');
    background.image = reference;
  }
  for (const path of assets.keys()) await prepareAsset(path);
  const stored: StoredAsset[] = [];
  for (const [path, asset] of assets) {
    const digest = sha256(asset.body);
    const key = `${prefix}/assets/${digest}`;
    if (!(await store.get(key))) await store.put(key, asset.body, {contentType: asset.contentType});
    stored.push({path, key, contentType: asset.contentType, bytes: asset.body.byteLength, sha256: digest, ...(asset.sourceUrl ? {sourceUrl: asset.sourceUrl} : {})});
  }
  snapshot.assets = [];
  const warnings = ['Google Fonts come from the Studio font proxy; all other runtime network requests are blocked. Dynamic resource URLs and JavaScript module imports are not captured.'];
  return {snapshot, assets: stored, warnings, ...(Object.keys(samplePins).length ? {sampleMedia: samplePins} : {})};
}
