import {posix} from 'node:path';
import {parse, serialize} from 'parse5';
import {CssSyntaxError} from 'postcss';
import type {JsonObject, JsonValue, RuntimeState} from '../src/types';
import {normalizeFields} from '../src/config/fields';
import type {ObjectStore, PreparedSnapshot, WidgetSnapshot} from './model';
import {assertSafeSnapshot, attribute, elements, rewriteCss, setAttribute, setText, sha256, textContent} from './importer';
import {claimsSampleMediaScheme, collectSampleMediaReferences} from '../src/studio-ui/sample-media';
import {deployedSampleMedia, sampleMediaDataUrl, type SampleMediaSource} from './sample-media';
import {htmlRefusals, missingPlaceholderWarning, substitutePlaceholders, substitutedHtmlError, hasPlaceholder} from '../src/config/placeholders';
import {canonicalGoogleFontsUrl, isGoogleFontsHost} from '../src/runtime/google-fonts-url';
import {previewAssetBytes, previewResponseBytes} from './limits';

/**
 * Resolves a Google Fonts URL on the server for the preview (`cssForPreview` bound to the real
 * store). A stylesheet comes back as CSS whose font files point at the public cache-only route.
 */
export type PreviewFontSource = (url: string, options: {sampleText: string; deadline: number}) => Promise<
  | {status: 'ok'; kind: 'css'; css: string; partial: boolean}
  | {status: 'ok'; kind: 'font'; href: string}
  | {status: 'upstream-4xx'; httpStatus: number; message: string}
  | {status: 'unavailable'; message: string}>;
interface PreviewOptions {
  origin: string; sessionId: string; nonce: string; sceneId?: string; themeId?: string; fieldData?: JsonObject;
  /** Server-side Google Fonts. Without it, Google URLs stay as written and the frame's broker asks the editor. */
  fonts?: PreviewFontSource;
  /** Time for server-side Google Fonts; what is left unresolved goes to the frame's broker. Default 8 s. */
  fontBudgetMs?: number;
}
/** The public, cache-only font route; the only path the preview CSP adds to `font-src`. */
export const PREVIEW_FONT_PATH = '/api/fonts/v1/f/';
const PREVIEW_FONT_BUDGET_MS = 8_000;
function merge(...objects: (JsonObject | undefined)[]): JsonObject { return Object.assign({}, ...objects.filter(Boolean).map(value => structuredClone(value))); }

const PREVIEW_ASSET_LIMIT = 3 * 1024 * 1024;

/** The editor host may display only embedded, verified images, never submitted remote URLs. */
export async function previewBackground(prepared: PreparedSnapshot, store: ObjectStore, options: Pick<PreviewOptions, 'sceneId'>, sampleMedia: SampleMediaSource = deployedSampleMedia): Promise<string | undefined> {
  const reference = prepared.snapshot.scenes.find(scene => scene.id === options.sceneId)?.background?.image;
  if (!reference) return undefined;
  if (claimsSampleMediaScheme(reference)) {
    const sample = await sampleMediaDataUrl(reference, sampleMedia, prepared.sampleMedia);
    if (sample.bytes > PREVIEW_ASSET_LIMIT) throw new Error('Interactive preview background exceeds the 3 MB limit.');
    return sample.dataUrl;
  }
  if (reference.startsWith('data:')) {
    if (!/^data:image\/(?:png|jpeg|gif|webp|avif|svg\+xml)(?:;[^,]*)?,/i.test(reference)) throw new Error('Preview backgrounds must be embedded image data.');
    if (Buffer.byteLength(reference) > 3 * 1024 * 1024) throw new Error('Interactive preview background exceeds the 3 MB limit.');
    return reference;
  }
  const asset = prepared.assets.find(item => item.path === reference);
  if (!asset || !/^image\/(?:png|jpeg|gif|webp|avif|svg\+xml)$/i.test(asset.contentType)) throw new Error('Preview background is not a captured image.');
  if (asset.bytes > 3 * 1024 * 1024) throw new Error('Interactive preview background exceeds the 3 MB limit.');
  const object = await store.get(asset.key);
  if (!object || object.body.byteLength !== asset.bytes || sha256(object.body) !== asset.sha256) throw new Error('Preview background integrity check failed.');
  return `data:${asset.contentType};base64,${Buffer.from(object.body).toString('base64')}`;
}

export function previewState(snapshot: WidgetSnapshot, options: Pick<PreviewOptions, 'sessionId' | 'sceneId' | 'themeId' | 'fieldData'>): RuntimeState {
  assertSafeSnapshot(snapshot, options.fieldData);
  const scene = options.sceneId ? snapshot.scenes.find(item => item.id === options.sceneId) : undefined;
  if (options.sceneId && !scene) throw new Error(`Scene not found: ${options.sceneId}`);
  const themeId = options.themeId ?? scene?.theme;
  const theme = themeId ? snapshot.themes.find(item => item.id === themeId) : undefined;
  if (themeId && !theme) throw new Error(`Theme not found: ${themeId}`);
  const fixture = scene?.fixture ? snapshot.fixtures.find(item => item.id === scene.fixture) : undefined;
  if (scene?.fixture && !fixture) throw new Error(`Fixture not found: ${scene.fixture}`);
  return {sessionId: options.sessionId, fieldData: merge(normalizeFields(snapshot.widget.fields).defaults, theme?.fieldData, fixture?.fieldData, scene?.fieldData, options.fieldData), channel: merge({username: 'streamer'}, snapshot.channel, fixture?.channel), recents: merge(fixture?.recents), seed: 1337, fixedTime: '2025-01-15T12:00:00.000Z'};
}

/** A Google Fonts or other absolute URL that a substituted value put into the page. */
const REMOTE_REFERENCE = /^(?:[a-z][a-z\d+.-]*:)?\/\//i;

export interface PreviewDocument {html: string; warnings: string[]}

/** Prepared resources are data URLs inside an opaque iframe, never executable uploads on the editor origin. */
export async function previewHtml(prepared: PreparedSnapshot, store: ObjectStore, options: PreviewOptions, sampleMedia: SampleMediaSource = deployedSampleMedia): Promise<string> {
  return (await previewDocument(prepared, store, options, sampleMedia)).html;
}

/**
 * The preview page, with `{{field}}` placeholders in the widget HTML, CSS and JS substituted from
 * the effective preview `fieldData`, as StreamElements does. Problems that StreamElements would
 * survive (a value that breaks CSS parsing, an unknown placeholder, a Google Fonts URL the preview
 * cannot load yet) are warnings, not errors.
 */
export async function previewDocument(prepared: PreparedSnapshot, store: ObjectStore, options: PreviewOptions, sampleMedia: SampleMediaSource = deployedSampleMedia): Promise<PreviewDocument> {
  assertSafeSnapshot(prepared.snapshot, options.fieldData);
  for (const value of Object.values(options.fieldData ?? {})) if (typeof value === 'string' && /^(?:https?:|\/\/|blob:)/i.test(value)) throw new Error('New remote field resources must be saved and prepared before preview.');
  const origin = new URL(options.origin).origin;
  if (!['https:', 'http:'].includes(new URL(origin).protocol)) throw new Error('Invalid preview origin.');
  if (!/^[A-Za-z0-9_-]{16,160}$/.test(options.nonce)) throw new Error('Invalid preview nonce.');
  const warnings: string[] = [];
  const warn = (message: string) => { if (!warnings.includes(message)) warnings.push(message); };
  const resources = new Map<string, string>();
  const visiting = new Set<string>();
  let assetBytes = 0;
  // Google Fonts captured into `_import/` by older revisions revert to their Google URL, so the page
  // loads the proxy's bytes and never mixes the old capture with them.
  const capturedGoogle = new Map(prepared.assets.filter(asset => asset.sourceUrl && canonicalGoogleFontsUrl(asset.sourceUrl).ok).map(asset => [asset.path, asset.sourceUrl!]));
  const fontDeadline = Date.now() + (options.fontBudgetMs ?? PREVIEW_FONT_BUDGET_MS);
  let fontSample = '';
  const googleResults = new Map<string, Promise<{value: string; partial: boolean} | undefined>>();
  /** A Google Fonts URL resolved on the server: data: CSS for a stylesheet, the public route for a font file. */
  const google = (reference: string): Promise<{value: string; partial: boolean} | undefined> => {
    const url = reference.trim().startsWith('//') ? `https:${reference.trim()}` : reference.trim();
    const known = googleResults.get(url);
    if (known) return known;
    const pending = (async () => {
      if (!options.fonts) { warn(`Google Fonts are resolved by the Studio's font proxy; this preview has none, so text uses a fallback font (${url}).`); return undefined; }
      if (Date.now() >= fontDeadline) { warn(`Google Fonts took too long on the server; the preview asks for ${url} while it runs.`); return undefined; }
      const result = await options.fonts(url, {sampleText: fontSample, deadline: fontDeadline});
      if (result.status === 'ok') return result.kind === 'css' ? {value: `data:text/css;base64,${Buffer.from(result.css).toString('base64')}`, partial: result.partial} : {value: result.href, partial: false};
      warn(result.status === 'upstream-4xx'
        ? `Google Fonts refused ${url} (HTTP ${result.httpStatus}); that text stays in a fallback font, as in StreamElements.`
        : `Google Fonts could not be loaded for ${url}: ${result.message}`);
      return undefined;
    })();
    googleResults.set(url, pending);
    return pending;
  };
  /** The Google URL a reference stands for: itself, or the source of a captured `_import/` copy. */
  const googleSource = (reference: string, base = ''): string | undefined => {
    const trimmed = reference.trim();
    if (REMOTE_REFERENCE.test(trimmed)) {
      let host = '';
      try { host = new URL(trimmed, 'https://invalid.invalid/').hostname; } catch { host = ''; }
      return isGoogleFontsHost(host) ? trimmed : undefined;
    }
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('data:') || claimsSampleMediaScheme(trimmed) || hasPlaceholder(trimmed)) return undefined;
    return capturedGoogle.get(posix.normalize(posix.join(base ? posix.dirname(base) : '', trimmed.split(/[?#]/, 1)[0]!)));
  };
  const inline = async (reference: string, base = ''): Promise<string> => {
    if (!reference || reference.startsWith('#') || reference.startsWith('data:')) return reference;
    if (hasPlaceholder(reference)) { warn(`Preview left ${JSON.stringify(reference)} as written: its {{field}} has no value.`); return reference; }
    const googleUrl = googleSource(reference, base);
    if (googleUrl) return (await google(googleUrl))?.value ?? googleUrl;
    if (REMOTE_REFERENCE.test(reference.trim())) {
      warn(`Preview blocks the remote resource a field value points to: ${reference}. Save the value as a captured asset to preview it.`);
      return reference;
    }
    const sample = claimsSampleMediaScheme(reference) ? resources.get(reference) : undefined;
    if (sample) return sample;
    const path = posix.normalize(posix.join(base ? posix.dirname(base) : '', reference.split(/[?#]/, 1)[0]!));
    const existing = resources.get(path);
    if (existing) return existing;
    if (visiting.has(path)) throw new Error('Cyclic preview resource dependency.');
    const asset = prepared.assets.find(item => item.path === path);
    if (!asset) throw new Error(`Preview resource is missing: ${path}`);
    const object = await store.get(asset.key);
    if (!object || object.body.byteLength !== asset.bytes || sha256(object.body) !== asset.sha256) throw new Error(`Preview resource integrity check failed: ${path}`);
    assetBytes += object.body.byteLength;
    if (assetBytes > previewAssetBytes()) throw new Error(`Interactive preview supports up to ${previewAssetBytes() / 1024 / 1024} MiB of captured assets. Use a smaller preview revision; server-side jobs retain the 100 MB revision limit.`);
    visiting.add(path);
    const body = asset.contentType === 'text/css' || path.endsWith('.css') ? Buffer.from(await rewriteCss(Buffer.from(object.body).toString('utf8'), ref => inline(ref, path))) : Buffer.from(object.body);
    const data = `data:${asset.contentType};base64,${body.toString('base64')}`;
    resources.set(path, data); visiting.delete(path);
    return data;
  };
  /** Substituted CSS that no longer parses passes through unchanged, as a browser would keep the rest of it. */
  const inlineCss = async (css: string, label: string): Promise<string> => {
    try { return await rewriteCss(css, ref => inline(ref)); }
    catch (error) {
      if (!(error instanceof CssSyntaxError)) throw error;
      warn(`${label} does not parse after {{field}} substitution (${error.reason}); it is used as is, so its url() references are not embedded.`);
      return css;
    }
  };
  // The effective state comes first: placeholders are substituted from it.
  const state = previewState(prepared.snapshot, options);
  fontSample = Object.values(state.fieldData).filter((value): value is string => typeof value === 'string' && !/^(?:[a-z][a-z\d+.-]*:|\/)/i.test(value)).join(' ').slice(0, 1000);
  for (const asset of prepared.assets) if (!capturedGoogle.has(asset.path)) await inline(asset.path);
  // Embed only the samples the effective preview state and the scene fixture use, as verified data URLs.
  const sceneFixture = prepared.snapshot.fixtures.find(item => item.id === prepared.snapshot.scenes.find(scene => scene.id === options.sceneId)?.fixture);
  for (const reference of collectSampleMediaReferences({fieldData: state.fieldData, channel: state.channel, recents: state.recents, events: sceneFixture?.events ?? []})) {
    const sample = await sampleMediaDataUrl(reference, sampleMedia, prepared.sampleMedia);
    assetBytes += sample.bytes;
    if (assetBytes > previewAssetBytes()) throw new Error(`Interactive preview supports up to ${previewAssetBytes() / 1024 / 1024} MiB of captured assets and sample media together. Sample media counts toward this preview budget; use fewer samples in this scene. Server-side jobs are not limited by it.`);
    resources.set(reference, sample.dataUrl);
  }
  // Captured media and samples are substituted as the data URLs the runtime maps them to.
  const values: JsonObject = Object.fromEntries(Object.entries(state.fieldData).map(([key, value]) => [key, typeof value === 'string' && resources.has(value) ? resources.get(value)! : value]));
  const substitute = (text: string, file: string) => {
    const result = substitutePlaceholders(text, values);
    if (result.missing.length) warn(missingPlaceholderWarning(file, result.missing));
    return result.text;
  };
  const html = substitute(prepared.snapshot.widget.html, 'Widget HTML');
  // Substituted values never went through the import checks.
  const refused = htmlRefusals(html);
  if (refused.length) throw new Error(substitutedHtmlError(refused));
  const document = parse(html);
  for (const node of elements(document)) {
    const href = node.tagName === 'link' ? attribute(node, 'href') : undefined;
    const googleHref = href ? googleSource(href) : undefined;
    if (googleHref) {
      // The frame's broker reports the original URL from `href` and never touches this link again.
      const resolved = await google(googleHref);
      setAttribute(node, 'href', resolved?.value ?? googleHref);
      if (resolved) {
        setAttribute(node, 'data-sws-original-href', googleHref);
        if (resolved.partial) setAttribute(node, 'data-sws-font-partial', '');
      }
    }
    for (const name of ['src', 'poster', 'data-sws-src', ...(node.tagName === 'link' && !googleHref ? ['href'] : [])]) { const value = attribute(node, name); if (value) setAttribute(node, name, await inline(value)); }
    const style = attribute(node, 'style');
    if (style) setAttribute(node, 'style', await inlineCss(style, 'An inline style attribute'));
    if (node.tagName === 'style') setText(node, await inlineCss(textContent(node), 'A <style> element'));
  }
  const css = await inlineCss(substitute(prepared.snapshot.widget.css, 'Widget CSS'), 'Widget CSS');
  const widgetScriptUrl = `data:text/javascript;base64,${Buffer.from(substitute(prepared.snapshot.widget.js, 'Widget JS')).toString('base64')}`;
  const runtime = {
    sessionId: options.sessionId, nonce: options.nonce, parentOrigin: origin,
    widgetScriptUrl, timeoutMs: prepared.snapshot.widget.ready?.timeoutMs ?? 10_000,
    ...(prepared.snapshot.widget.ready?.selector ? {readySelector: prepared.snapshot.widget.ready.selector} : {}),
    assetMap: Object.fromEntries(resources),
    fontBroker: true
  };
  const csp = `default-src 'none'; script-src 'nonce-${options.nonce}' data: blob: ${origin}/engine/; style-src 'unsafe-inline' data:; img-src data: blob:; font-src data: ${origin}${PREVIEW_FONT_PATH}; media-src data: blob:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'`;
  const bootstrap = `import {installFrameRuntime} from ${JSON.stringify(`${origin}/engine/runtime/frame.js`)};installFrameRuntime(${JSON.stringify(runtime).replaceAll('<', '\\u003c')});`;
  const cssUrl = `data:text/css;base64,${Buffer.from(css).toString('base64')}`;
  const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  const head = `<meta http-equiv="Content-Security-Policy" content="${escape(csp)}"><meta name="referrer" content="no-referrer"><link rel="stylesheet" href="${escape(cssUrl)}">`;
  const page = serialize(document).replace(/<head>/, `<head>${head}`).replace('</body>', `<script type="module" nonce="${options.nonce}">${bootstrap}</script></body>`);
  if (Buffer.byteLength(page) > previewResponseBytes()) throw new Error(`Interactive preview document exceeds the ${previewResponseBytes() / 1_000_000} MB response limit. Reduce embedded assets or source size.`);
  return {html: page, warnings};
}
