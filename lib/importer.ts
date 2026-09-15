import {createHash} from 'node:crypto';
import {lookup} from 'node:dns/promises';
import {request} from 'node:https';
import {isIP} from 'node:net';
import {posix} from 'node:path';
import {parse, serialize, type DefaultTreeAdapterMap} from 'parse5';
import postcss from 'postcss';
import type {JsonValue} from '../src/types';
import {normalizeFields} from '../src/config/fields';
import {inspectSensitive} from '../src/validation/privacy';
import type {ObjectStore, PreparedSnapshot, StoredAsset, WidgetSnapshot} from './model';

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

export async function fetchPublicAsset(input: string, redirects = 0, deadline = Date.now() + 20_000): Promise<{body: Buffer; contentType: string}> {
  if (redirects > 4) throw new Error('Remote asset exceeded the redirect limit.');
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw new Error('Remote assets require public HTTPS URLs without credentials or custom ports.');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (Date.now() >= deadline) throw new Error('Asset preparation exceeded its time budget.');
  let dnsTimer: ReturnType<typeof setTimeout> | undefined;
  const answers = isIP(hostname) ? [{address: hostname, family: isIP(hostname)}] : await Promise.race([lookup(hostname, {all: true}), new Promise<never>((_resolve, reject) => { dnsTimer = setTimeout(() => reject(new Error('Remote DNS lookup timed out.')), Math.min(5000, deadline - Date.now())); })]).finally(() => { if (dnsTimer) clearTimeout(dnsTimer); });
  if (!answers.length || answers.some(answer => !isPublicAddress(answer.address))) throw new Error('Remote asset resolved to a private or special-use address.');
  const pinned = answers[0]!;
  return new Promise((resolve, reject) => {
    const finish = (error?: Error, value?: {body: Buffer; contentType: string}) => { clearTimeout(deadlineTimer); if (error) reject(error); else if (value) resolve(value); };
    const req = request(url, {method: 'GET', family: pinned.family, headers: {'User-Agent': 'SE-Widget-Studio/0.2', Accept: '*/*'}, lookup: (_host, _options, callback) => callback(null, pinned.address, pinned.family)}, response => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.destroy();
        clearTimeout(deadlineTimer);
        fetchPublicAsset(new URL(response.headers.location, url).href, redirects + 1, deadline).then(resolve, reject);
        return;
      }
      if (status !== 200) { response.destroy(); finish(new Error(`Remote asset returned HTTP ${status}.`)); return; }
      if (Number(response.headers['content-length'] ?? 0) > MAX_FILE_BYTES) { response.destroy(); finish(new Error('Remote asset exceeds the 10 MB per-file limit.')); return; }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > MAX_FILE_BYTES) { response.destroy(new Error('Remote asset exceeds the 10 MB per-file limit.')); } else chunks.push(chunk); });
      response.on('error', finish);
      response.on('end', () => finish(undefined, {body: Buffer.concat(chunks), contentType: String(response.headers['content-type'] ?? 'application/octet-stream').split(';')[0]!}));
    });
    const deadlineTimer = setTimeout(() => req.destroy(new Error('Asset preparation exceeded its time budget.')), Math.max(1, deadline - Date.now()));
    req.setTimeout(15_000, () => req.destroy(new Error('Remote asset timed out.')));
    req.on('error', finish);
    req.end();
  });
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

export async function rewriteCss(css: string, resolve: (url: string) => Promise<string>): Promise<string> {
  const tree = postcss.parse(css);
  const declarations: {value: string}[] = [];
  tree.walkDecls(declaration => { declarations.push(declaration); });
  const imports: {params: string}[] = [];
  tree.walkAtRules('import', rule => { imports.push(rule); });
  for (const declaration of declarations) {
    const matches = [...declaration.value.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]+))\s*\)/gi)];
    for (const match of matches) declaration.value = declaration.value.replace(match[0], `url(${JSON.stringify(await resolve(match[1] ?? match[2] ?? match[3] ?? ''))})`);
  }
  for (const rule of imports) {
    const match = /^(?:url\(\s*)?(?:"([^"]*)"|'([^']*)'|([^\s)]+))\s*\)?(.*)$/i.exec(rule.params);
    if (!match) throw new Error('Unsupported CSS import syntax.');
    rule.params = `url(${JSON.stringify(await resolve(match[1] ?? match[2] ?? match[3] ?? ''))})${match[4] ?? ''}`;
  }
  return tree.toString();
}

export async function prepareSnapshot(source: WidgetSnapshot, store: ObjectStore, prefix: string): Promise<PreparedSnapshot> {
  assertSafeSnapshot(source);
  const deadline = Date.now() + 45_000;
  const snapshot = structuredClone(source);
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
      const fetched = await fetchPublicAsset(asset.url, 0, deadline);
      add(asset.path, fetched.body, asset.contentType ?? fetched.contentType, asset.url);
    } else if (asset.content !== undefined) {
      if (asset.encoding === 'base64' && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(asset.content)) throw new Error('Invalid base64 asset content.');
      add(asset.path, Buffer.from(asset.content, asset.encoding === 'base64' ? 'base64' : 'utf8'), asset.contentType ?? mimeTypes[posix.extname(asset.path).toLowerCase()] ?? 'application/octet-stream');
    } else throw new Error(`Asset has no content: ${asset.path}`);
  }
  const resolveReference = async (reference: string, base = '', destination = ''): Promise<string> => {
    if (!reference || reference.startsWith('#') || reference.startsWith('data:')) return reference;
    if (/^(?:blob:|javascript:|file:|http:)/i.test(reference)) throw new Error('Only captured project assets, data URLs, and public HTTPS imports are supported.');
    let path: string;
    const remote = /^https:\/\//i.test(reference) || reference.startsWith('//') || base.startsWith('https:');
    if (remote) {
      const url = new URL(reference, base || 'https://invalid.invalid/').href;
      const existing = remotePaths.get(url);
      if (existing) path = existing;
      else {
        const fetched = await fetchPublicAsset(url, 0, deadline);
        const originalExtension = posix.extname(new URL(url).pathname).toLowerCase();
        const extension = mimeTypes[originalExtension] ? originalExtension : Object.entries(mimeTypes).find(([, type]) => type === fetched.contentType)?.[0];
        if (!extension) throw new Error('Remote dependency has an unsupported content type.');
        path = `_import/${sha256(url).slice(0, 24)}${extension}`;
        add(path, fetched.body, fetched.contentType, url);
      }
    } else {
      const clean = reference.split(/[?#]/, 1)[0]!;
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
    if (['base', 'iframe', 'object', 'embed'].includes(node.tagName) || (node.tagName === 'meta' && attribute(node, 'http-equiv'))) throw new Error(`Unsupported embedded or document-control element: ${node.tagName}`);
    if (node.attrs.some(attr => attr.name.startsWith('on'))) throw new Error('Inline HTML event handlers are unsupported. Register listeners in widget JavaScript after runtime initialization.');
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
  const rewriteFieldData = async (data: Record<string, JsonValue>) => { for (const key of mediaFields) if (typeof data[key] === 'string' && data[key]) data[key] = await resolveReference(String(data[key])); };
  const raw = snapshot.widget.fields;
  const fields = raw && typeof raw === 'object' && !Array.isArray(raw) && 'fields' in raw ? raw.fields : raw;
  if (fields && typeof fields === 'object') for (const [key, value] of Object.entries(fields)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const id = Array.isArray(fields) ? String(value.id ?? value.name ?? key) : key;
    if (mediaFields.has(id)) for (const property of ['value', 'default']) if (typeof value[property] === 'string' && value[property]) value[property] = await resolveReference(String(value[property]));
  }
  for (const item of [...snapshot.themes, ...snapshot.fixtures, ...snapshot.scenes]) if (item.fieldData) await rewriteFieldData(item.fieldData);
  const backgrounds = [...snapshot.scenes.flatMap(scene => scene.background ? [scene.background] : []), ...snapshot.recipes.flatMap(recipe => recipe.matrix?.backgrounds ?? [])];
  for (const background of backgrounds) {
    if (!background.image) continue;
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
  const warnings = ['Runtime network requests are blocked. Dynamic resource URLs and JavaScript module imports are not captured.'];
  return {snapshot, assets: stored, warnings};
}
