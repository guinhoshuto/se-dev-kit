#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {realpathSync} from 'node:fs';
import {lstat, mkdir, readFile, realpath, writeFile} from 'node:fs/promises';
import {homedir, platform} from 'node:os';
import {basename, dirname, extname, isAbsolute, posix, relative, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

// The local Studio that `npm run serve` starts in the Studio checkout. The hosted deployment is paused.
export const DEFAULT_ORIGIN = 'http://127.0.0.1:4310';
const JSON_LIMIT = 4_000_000;
const UPLOAD_LIMIT = 10 * 1024 * 1024;
// The server's job budget and artifact limits (lib/limits.ts): a local Studio allows longer jobs and larger files.
export function originLimits(origin) {
  return isLoopback(origin) ? {jobMs: 125 * 60_000, artifact: 512 * 1024 * 1024} : {jobMs: 10 * 60_000, artifact: 100 * 1024 * 1024};
}
const ID = /^[a-zA-Z0-9_-]{1,100}$/;
const SAMPLE_SCHEME = 'sws-sample:';
// The Studio repository's sample-media manifest, reached when the skill runs from a checkout or a linked skill
// directory (Node resolves the entry point's real path). A copied skill has none and relies on the server check.
const SAMPLE_MANIFEST = resolve(dirname(fileURLToPath(import.meta.url)), '../../../sample-media/manifest.json');
// The same checkout's engine build, which --config uses to read a se-widget-studio.config.mjs as the local CLI does.
const ENGINE_DIST = resolve(dirname(fileURLToPath(import.meta.url)), '../../../dist');
// Per-revision catalog limit of the Studio API (lib/schema.ts).
const CATALOG_LIMIT = 48;
const sleep = ms => new Promise(done => setTimeout(done, ms));

function fail(message) {throw new Error(message);}
function check(condition, message) {if (!condition) fail(message);}
function isLoopback(origin) {return ['127.0.0.1', '[::1]', 'localhost'].includes(new URL(origin).hostname);}

/** fetch, with a refused loopback connection reported as a Studio that is not running. */
export async function studioFetch(url, init) {
  try {return await fetch(url, init);} catch (error) {
    const code = error?.cause?.code ?? error?.code;
    if (isLoopback(url) && (code === 'ECONNREFUSED' || code === 'ECONNRESET')) fail(`No Studio is running at ${new URL(url).origin}. Start the local Studio in the Studio checkout with \`npm run serve\` (run \`npm run build\` first after a change to the checkout), keep it running in the background, and run this command again. Nothing was changed.`);
    throw error;
  }
}

export function normalizeOrigin(value) {
  let url;
  try {url = new URL(value);} catch {fail('Origin must be an absolute HTTP(S) URL.');}
  const loopback = isLoopback(url.origin);
  check(!url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'Origin must contain only a scheme and host.');
  check(url.protocol === 'https:' || (url.protocol === 'http:' && loopback), 'Remote Studio origins must use HTTPS.');
  return url.origin;
}

function parseFlags(args, allowed) {
  const result = {};
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    check(name?.startsWith('--') && allowed.has(name), `Unknown option ${name ?? ''}. Run with --help.`);
    check(!Object.hasOwn(result, name), `${name} may only appear once.`);
    const value = args[++index];
    check(value && !value.startsWith('--'), `${name} requires a value.`);
    result[name] = value;
  }
  return result;
}

function required(flags, name) {
  const value = flags[name];
  check(value, `${name} is required.`);
  return value;
}

async function exists(path) {
  try {const value = await lstat(path); return value.isFile();} catch (error) {if (error?.code === 'ENOENT') return false; throw error;}
}

async function safeSource(root, name) {
  const actual = await realpath(resolve(root, name));
  const rel = relative(root, actual);
  check(rel && !rel.startsWith('..') && !isAbsolute(rel), `Source file escapes the widget root: ${name}`);
  const info = await lstat(actual);
  check(info.isFile() && !info.isSymbolicLink() && info.size <= JSON_LIMIT, `Source must be a bounded regular file: ${name}`);
  return readFile(actual, 'utf8');
}

function assetPath(value) {
  check(typeof value === 'string' && value.length > 0 && value.length <= 240, 'Asset path must be a nonempty relative string.');
  check(value === posix.normalize(value) && !value.startsWith('/') && !value.startsWith('.') && !value.includes('\\') && !value.includes('%') && !/[\s?#\u0000-\u001f\u007f]/.test(value) && !value.split('/').some(part => !part || part === '..'), `Unsafe asset path: ${value}`);
  check(!['widget.html', 'widget.css', 'widget.js', 'fields.json'].includes(value), `Reserved asset path: ${value}`);
  return value;
}

function contentType(path, supplied) {
  if (supplied) {check(typeof supplied === 'string' && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(supplied), `Invalid content type for ${path}`); return supplied;}
  const known = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.json': 'application/json', '.txt': 'text/plain'};
  return known[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

async function localAsset(root, entry) {
  check(entry && typeof entry === 'object' && !Array.isArray(entry), 'Asset entries must be objects.');
  const keys = Object.keys(entry); const allowed = new Set(['path', 'file', 'contentType']);
  check(keys.every(key => allowed.has(key)), `Local file asset has unsupported keys: ${keys.filter(key => !allowed.has(key)).join(', ')}`);
  const path = assetPath(entry.path);
  check(typeof entry.file === 'string' && entry.file.length > 0 && !isAbsolute(entry.file), `Local asset file must be relative to the widget root: ${path}`);
  const actual = await realpath(resolve(root, entry.file));
  const rel = relative(root, actual);
  check(rel && !rel.startsWith('..') && !isAbsolute(rel), `Local asset escapes the widget root: ${entry.file}`);
  const info = await lstat(actual);
  check(info.isFile() && info.size > 0 && info.size <= UPLOAD_LIMIT, `Local asset must be a regular file no larger than 10 MiB: ${entry.file}`);
  return {path, contentType: contentType(path, entry.contentType), bytes: await readFile(actual)};
}

const LAYOUTS = [
  {html: 'widget.html', css: 'widget.css', js: 'widget.js', fields: 'widget.json'},
  {html: 'index.html', css: 'style.css', js: 'script.js', fields: 'fields.json'}
];

/** `catalog` is a JSON file; `catalogData` and `layout` come from a config flattened by the engine (--config). */
async function buildImportDefinition(widgetRoot, {catalog, catalogData, layout: configured, name} = {}) {
  const root = await realpath(resolve(widgetRoot));
  let layout = configured && LAYOUTS.find(candidate => Object.keys(candidate).every(kind => candidate[kind] === configured[kind]));
  if (!configured) {
    const matches = [];
    for (const candidate of LAYOUTS) {
      if ((await Promise.all(Object.values(candidate).map(file => exists(resolve(root, file))))).every(Boolean)) matches.push(candidate);
    }
    check(matches.length === 1, matches.length ? 'Widget root is ambiguous; both supported production layouts are complete.' : 'Widget root does not contain a supported complete production layout.');
    layout = matches[0];
  }
  check(layout, 'The config names production files that a Studio import does not read.');
  const [html, css, js, fieldsText] = await Promise.all([safeSource(root, layout.html), safeSource(root, layout.css), safeSource(root, layout.js), safeSource(root, layout.fields)]);
  let fields;
  try {fields = JSON.parse(fieldsText);} catch {fail(`${layout.fields} is not valid JSON.`);}
  let extra = catalogData ?? {};
  if (catalog) {
    try {extra = JSON.parse(await readFile(resolve(catalog), 'utf8'));} catch (error) {fail(`Catalog is not valid readable JSON: ${error instanceof Error ? error.message : String(error)}`);}
    check(extra && typeof extra === 'object' && !Array.isArray(extra), 'Catalog must be a JSON object.');
  }
  const widget = extra.widget ?? {};
  check(widget && typeof widget === 'object' && !Array.isArray(widget), 'Catalog widget options must be an object.');
  const forbidden = Object.keys(widget).filter(key => !['viewport', 'ready', 'fieldUpdate'].includes(key));
  check(forbidden.length === 0, `Catalog cannot override production widget source: ${forbidden.join(', ')}`);
  const localAssets = []; const hostedAssets = [];
  check(extra.assets === undefined || Array.isArray(extra.assets), 'Catalog assets must be an array.');
  for (const entry of extra.assets ?? []) {
    if (entry && typeof entry === 'object' && Object.hasOwn(entry, 'file')) localAssets.push(await localAsset(root, entry));
    else hostedAssets.push(entry);
  }
  check(new Set([...hostedAssets.map(entry => entry?.path), ...localAssets.map(entry => entry.path)]).size === hostedAssets.length + localAssets.length, 'Asset paths must be unique.');
  const snapshot = {...extra, schemaVersion: 1, name: name ?? extra.name ?? basename(root), widget: {html, css, js, fields, ...widget}, assets: hostedAssets};
  const bytes = Buffer.byteLength(JSON.stringify(snapshot));
  check(bytes <= JSON_LIMIT, `Snapshot is ${bytes} bytes; the Studio JSON limit is ${JSON_LIMIT}. Use upload reservations for large assets.`);
  return {snapshot, localAssets};
}

function recipeIds(value) {
  const ids = [...new Set(value.split(',').map(id => id.trim()).filter(Boolean))];
  check(ids.length > 0 && ids.every(id => ID.test(id)), '--recipes must be a comma-separated list of recipe IDs.');
  return ids;
}

/**
 * Reads a se-widget-studio.config.mjs with the engine of the Studio checkout this skill runs from, exactly as
 * the local CLI loads it, and flattens it into an import catalog. The config is trusted local code, as for the
 * CLI; nothing is sent anywhere. Warns when that engine build is dirty or older than its source.
 */
export async function configCatalog(configPath, {recipes, engineDist = ENGINE_DIST} = {}) {
  const entry = resolve(engineDist, 'config/hosted-catalog.js');
  check(await exists(entry), `--config reads the config with the engine of the SE Widget Studio checkout this skill runs from, and ${entry} is missing. Run npm run build:engine in that checkout. A copied skill has no engine: build a JSON catalog by hand as references/studio-workflow.md describes, and pass --catalog.`);
  const {buildFreshness} = await import(pathToFileURL(resolve(engineDist, 'build-info.js')).href);
  for (const warning of (await buildFreshness(engineDist)).warnings) process.stderr.write(`[se-widget-studio] Warning ${warning.code}: ${warning.detail} ${warning.hint}\n`);
  const {hostedCatalogFromConfig} = await import(pathToFileURL(entry).href);
  let result;
  try {result = await hostedCatalogFromConfig(resolve(configPath), recipes ? {recipes} : {});}
  catch (error) {fail(`${error instanceof Error ? error.message : String(error)}${error?.hint ? ` ${error.hint}` : ''}`);}
  const over = ['themes', 'fixtures', 'scenes', 'scenarios', 'recipes'].filter(kind => result.catalog[kind].length > CATALOG_LIMIT);
  check(over.length === 0, `A Studio revision holds at most ${CATALOG_LIMIT} of each catalog kind, and this config has ${over.map(kind => `${result.catalog[kind].length} ${kind}`).join(', ')}. Pass --recipes <id,...> to keep only those recipes and the scenes, themes, and fixtures they use.`);
  // An engine build older than sample-copy detection returns no samples and uploads every widget file, as before.
  for (const sample of result.samples ?? []) {
    const how = sample.identical ? 'a copy of' : 'the original of the recompressed';
    process.stderr.write(`[se-widget-studio] Sample copy: ${sample.path} is ${how} ${sample.reference}, so the catalog names that sample and the file is not uploaded.\n`);
  }
  return result;
}

export async function buildSnapshot(widgetRoot, options = {}) {
  const {snapshot, localAssets} = await buildImportDefinition(widgetRoot, options);
  check(localAssets.length === 0, 'Catalog contains local file assets. Use the import command so they are uploaded privately.');
  return snapshot;
}

/** Every whole string that claims the sample scheme, in first-seen order, without duplicates. */
export function collectSampleReferences(value) {
  const found = new Set();
  const visit = (input, depth) => {
    if (depth > 64) return;
    if (typeof input === 'string') {if (input.startsWith(SAMPLE_SCHEME)) found.add(input);}
    else if (Array.isArray(input)) for (const item of input) visit(item, depth + 1);
    else if (input && typeof input === 'object') for (const item of Object.values(input)) visit(item, depth + 1);
  };
  visit(value, 0);
  return [...found];
}

async function localSampleManifest(manifestPath) {
  let text;
  try {text = await readFile(manifestPath, 'utf8');} catch (error) {if (error?.code === 'ENOENT') return undefined; throw error;}
  let manifest;
  try {manifest = JSON.parse(text);} catch {fail(`Local sample media manifest is not valid JSON: ${manifestPath}`);}
  check(Array.isArray(manifest?.items), `Local sample media manifest has no items: ${manifestPath}`);
  const retired = (Array.isArray(manifest.retired) ? manifest.retired : []).filter(item => typeof item?.reference === 'string');
  return {
    references: manifest.items.map(item => item?.reference).filter(reference => typeof reference === 'string'),
    retired: new Map(retired.map(item => [item.reference, item.retiredOn]))
  };
}

/**
 * Refuses sws-sample: references before any mutation: first offline against the Studio checkout's manifest
 * (when present), then against the list the selected deployment serves. An older deployment has no list and
 * would block the revision with an unrelated path error or pass gallery arrays through unresolved.
 */
export async function checkSampleMedia(origin, snapshot, {action = 'created', manifestPath = SAMPLE_MANIFEST} = {}) {
  const references = collectSampleReferences(snapshot);
  if (references.length === 0) return [];
  const local = await localSampleManifest(manifestPath);
  if (local) {
    const unknown = references.filter(reference => !local.references.includes(reference));
    const describe = reference => local.retired.has(reference) ? `${reference} (retired on ${local.retired.get(reference)})` : reference;
    check(unknown.length === 0, `Unknown sample media reference(s): ${unknown.map(describe).join(', ')}. Valid references: ${local.references.join(', ')}. Nothing was ${action}.`);
  }
  const url = new URL('/api/v1/sample-media', origin);
  const response = await studioFetch(url, {redirect: 'manual', signal: AbortSignal.timeout(60_000)});
  const bytes = await boundedBody(response, JSON_LIMIT);
  if (response.status === 404) fail(`The Studio at ${origin} does not support sws-sample: references: GET /api/v1/sample-media returned HTTP 404, so this deployment predates built-in sample media. Deploy a Studio version that ships sample-media/ or select one with --origin, and tell the user; do not upload or generate images as a workaround. Nothing was ${action}.`);
  check(response.status === 200, `The Studio at ${origin} could not list its sample media (HTTP ${response.status}). Nothing was ${action}.`);
  let data;
  try {data = JSON.parse(bytes.toString('utf8'));} catch {fail(`The Studio at ${origin} returned an invalid sample media list. Nothing was ${action}.`);}
  check(data?.schemaVersion === 1 && Array.isArray(data.items), `The Studio at ${origin} returned an invalid sample media list. Nothing was ${action}.`);
  const served = data.items.map(item => item?.reference).filter(reference => typeof reference === 'string');
  const missing = references.filter(reference => !served.includes(reference));
  check(missing.length === 0, `The Studio at ${origin} does not serve these sample references: ${missing.join(', ')}. It serves: ${served.join(', ')}. Nothing was ${action}.`);
  return references;
}

async function boundedBody(response, limit) {
  const declared = Number(response.headers.get('content-length'));
  check(!Number.isFinite(declared) || declared <= limit, 'Response exceeds the allowed byte count.');
  check(response.body, 'Response body is missing.');
  const reader = response.body.getReader(); const chunks = []; let length = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read(); if (done) break;
      length += value.byteLength; check(length <= limit, 'Response exceeds the allowed byte count.'); chunks.push(Buffer.from(value));
    }
  } finally {await reader.cancel().catch(() => {});}
  return Buffer.concat(chunks);
}

async function api(origin, path, {method = 'GET', token, body, headers = {}} = {}) {
  const url = new URL(path, origin);
  check(url.origin === origin && url.pathname.startsWith('/api/'), 'API request escaped the selected Studio origin.');
  const response = await studioFetch(url, {
    method, redirect: 'manual', signal: AbortSignal.timeout(60_000),
    headers: {...(body === undefined ? {} : {'Content-Type': 'application/json'}), ...(token ? {Authorization: `Bearer ${token}`} : {}), ...headers},
    ...(body === undefined ? {} : {body: JSON.stringify(body)})
  });
  check(response.status < 300 || response.status >= 400, 'Unexpected API redirect was blocked.');
  const bytes = await boundedBody(response, JSON_LIMIT);
  let data;
  try {data = JSON.parse(bytes.toString('utf8'));} catch {fail(`Studio returned non-JSON data (HTTP ${response.status}).`);}
  return {status: response.status, data};
}

function expect(result, statuses, operation) {
  if (statuses.includes(result.status)) return result.data;
  const diagnostic = typeof result.data?.error === 'string' ? ` ${result.data.error}` : '';
  fail(`${operation} failed with HTTP ${result.status}.${diagnostic}`);
}

async function writePrivate(path, value) {
  const target = resolve(path);
  await mkdir(dirname(target), {recursive: true, mode: 0o700});
  await writeFile(target, JSON.stringify(value, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  return target;
}

async function requireAbsent(path, label) {
  try {await lstat(resolve(path)); fail(`${label} already exists. Nothing was overwritten.`);}
  catch (error) {if (error?.code !== 'ENOENT') throw error;}
}

const ACCESS_PURPOSE = 'se-widget-studio-access';
// scripts/verify-hosted.mjs keeps the same capability as {purpose: 'hosted-verification', origin, projectId, revisionId, token}.
const VERIFICATION_PURPOSE = 'hosted-verification';

async function readPrivate(path, {purposes = [ACCESS_PURPOSE]} = {}) {
  const target = resolve(path);
  const info = await lstat(target);
  check(info.isFile() && !info.isSymbolicLink() && info.size < 64 * 1024, 'Access bundle must be a bounded regular file.');
  if (platform() !== 'win32') check((info.mode & 0o077) === 0, 'Access bundle permissions must be 0600.');
  const value = JSON.parse(await readFile(target, 'utf8'));
  check(value.schemaVersion === 1 && purposes.includes(value.purpose), 'Access bundle has an unsupported format.');
  check(ID.test(value.projectId) && typeof value.token === 'string' && /^[a-zA-Z0-9_-]{24,256}$/.test(value.token), 'Access bundle identifiers are invalid.');
  value.origin = normalizeOrigin(value.origin);
  // The verification file has no editorUrl; the Studio's editing link is always /p/<project>#key=<token>.
  if (value.purpose === VERIFICATION_PURPOSE && value.editorUrl === undefined) value.editorUrl = `/p/${value.projectId}#key=${value.token}`;
  check(typeof value.editorUrl === 'string' && value.editorUrl.startsWith(`/p/${value.projectId}#key=`), 'Access bundle editor URL is invalid.');
  return value;
}

async function importWidget(flags) {
  const origin = normalizeOrigin(flags['--origin'] ?? process.env.SE_WIDGET_STUDIO_URL ?? DEFAULT_ORIGIN);
  if (flags['--access-out']) await requireAbsent(flags['--access-out'], 'Access output');
  let source;
  if (flags['--config']) {
    check(!flags['--widget-root'] && !flags['--catalog'], '--config replaces --widget-root and --catalog; pass it alone.');
    const config = await configCatalog(flags['--config'], flags['--recipes'] ? {recipes: recipeIds(flags['--recipes'])} : {});
    source = [config.widgetRoot, {catalogData: config.catalog, layout: config.files, name: flags['--name']}];
  } else {
    check(!flags['--recipes'], '--recipes needs --config.');
    source = [required(flags, '--widget-root'), {catalog: flags['--catalog'], name: flags['--name']}];
  }
  const {snapshot, localAssets} = await buildImportDefinition(...source);
  check(localAssets.length <= 128 && localAssets.reduce((total, asset) => total + asset.bytes.length, 0) <= 100 * 1024 * 1024, 'Local asset upload exceeds the Studio revision limits.');
  await checkSampleMedia(origin, snapshot);
  const result = await api(origin, '/api/v1/projects', {method: 'POST', body: snapshot, headers: process.env.STUDIO_CREATE_KEY ? {'X-Studio-Key': process.env.STUDIO_CREATE_KEY} : {}});
  const created = expect(result, [201], 'Project creation');
  check(ID.test(created.projectId) && ID.test(created.revisionId) && typeof created.token === 'string' && /^[a-zA-Z0-9_-]{24,256}$/.test(created.token) && created.editorUrl === `/p/${created.projectId}#key=${created.token}`, 'Project creation returned an invalid access contract.');
  const access = {
    schemaVersion: 1, purpose: ACCESS_PURPOSE, origin, projectId: created.projectId,
    token: created.token, editorUrl: created.editorUrl, createdAt: new Date().toISOString()
  };
  const accessFile = await writePrivate(flags['--access-out'] ?? resolve(homedir(), '.se-widget-studio', `access-${created.projectId}.json`), access);
  let status = created.status; let revisionId = created.revisionId; let diagnostics;
  try {
    if (localAssets.length) {
      const uploaded = [];
      for (const asset of localAssets) uploaded.push(await uploadLocalAsset(access, asset));
      const current = await projectView(access);
      const completed = expect(await api(origin, `/api/v1/projects/${created.projectId}`, {method: 'PUT', token: created.token, headers: {'If-Match': current.etag}, body: {...snapshot, assets: [...(snapshot.assets ?? []), ...uploaded]}}), [200], 'Asset-backed project replacement');
      status = completed.revision.status; revisionId = completed.revision.id; diagnostics = completed.revision.diagnostics;
    }
  } catch (error) {
    throw new Error(`Project ${created.projectId} was created and its private access was saved at ${accessFile}, but local asset finalization failed. ${error instanceof Error ? error.message : ''}`);
  }
  // A blocked revision is still a created project: show why, so it is fixed with pull/push instead of a new import.
  if (status === 'blocked' && !localAssets.length) diagnostics = (await projectView(access).catch(() => undefined))?.revision?.diagnostics;
  const blocked = status === 'blocked' && Array.isArray(diagnostics) ? {diagnostics} : {};
  console.log(JSON.stringify({status, projectId: created.projectId, revisionId, accessFile, uploadedAssets: localAssets.length, editorAvailable: true, ...blocked}));
}

async function writeCatalog(flags) {
  const out = resolve(required(flags, '--out'));
  await requireAbsent(out, 'Catalog output');
  const config = await configCatalog(required(flags, '--config'), flags['--recipes'] ? {recipes: recipeIds(flags['--recipes'])} : {});
  await mkdir(dirname(out), {recursive: true});
  await writeFile(out, JSON.stringify(config.catalog, null, 2) + '\n', {flag: 'wx'});
  const counts = Object.fromEntries(['themes', 'fixtures', 'scenes', 'scenarios', 'recipes', 'assets'].map(kind => [kind, config.catalog[kind].length]));
  console.log(JSON.stringify({status: 'written', catalog: out, widgetRoot: config.widgetRoot, counts}));
}

async function uploadLocalAsset(access, asset) {
  const reservation = expect(await api(access.origin, `/api/v1/projects/${access.projectId}/uploads`, {method: 'POST', token: access.token, body: {bytes: asset.bytes.length, contentType: asset.contentType}}), [201], `Upload reservation for ${asset.path}`);
  check(ID.test(reservation.uploadId) && typeof reservation.url === 'string' && typeof reservation.method === 'string' && reservation.headers && typeof reservation.headers === 'object', 'Upload reservation returned an invalid contract.');
  const target = new URL(reservation.url, access.origin);
  const headers = {};
  for (const [name, value] of Object.entries(reservation.headers)) {
    check(typeof value === 'string' && name.toLowerCase() !== 'authorization', 'Upload reservation headers are invalid.');
    headers[name] = value;
  }
  if (reservation.requiresAuthorization) {
    check(target.origin === access.origin && target.pathname.startsWith(`/api/v1/projects/${access.projectId}/uploads/`), 'Authorized upload target escaped the Studio origin.');
    headers.Authorization = `Bearer ${access.token}`;
  } else check(target.protocol === 'https:' && !target.username && !target.password, 'Direct upload target must be an HTTPS URL without credentials.');
  const response = await fetch(target, {method: reservation.method, redirect: 'error', signal: AbortSignal.timeout(60_000), headers, body: asset.bytes});
  await response.body?.cancel().catch(() => {});
  check([200, 201, 204].includes(response.status), `Upload for ${asset.path} failed with HTTP ${response.status}.`);
  return {path: asset.path, contentType: asset.contentType, uploadId: reservation.uploadId};
}

async function projectView(access) {
  return expect(await api(access.origin, `/api/v1/projects/${access.projectId}`, {token: access.token}), [200], 'Project read');
}

async function status(flags) {
  const access = await readPrivate(required(flags, '--access'));
  const view = await projectView(access);
  console.log(JSON.stringify({
    project: view.project,
    revision: {id: view.revision.id, status: view.revision.status, diagnostics: view.revision.diagnostics, warnings: view.revision.prepared?.warnings ?? []},
    revisions: view.revisions,
    jobs: view.jobs.map(job => ({id: job.id, revisionId: job.revisionId, kind: job.kind, selection: job.selection, status: job.status, progress: job.progress, error: job.error, artifacts: job.artifacts.map(({id, name, contentType, bytes, sha256}) => ({id, name, contentType, bytes, sha256}))}))
  }, null, 2));
}

async function pull(flags) {
  const access = await readPrivate(required(flags, '--access'));
  const view = await projectView(access);
  const draftFile = await writePrivate(required(flags, '--draft-out'), {
    schemaVersion: 1, purpose: 'se-widget-studio-draft', origin: access.origin, projectId: access.projectId,
    revisionId: view.revision.id, etag: view.etag, snapshot: view.revision.snapshot
  });
  console.log(JSON.stringify({status: view.revision.status, projectId: access.projectId, revisionId: view.revision.id, draftFile}));
}

async function push(flags) {
  const access = await readPrivate(required(flags, '--access'));
  const draftPath = resolve(required(flags, '--draft'));
  const info = await lstat(draftPath);
  check(info.isFile() && !info.isSymbolicLink() && info.size <= JSON_LIMIT, 'Draft must be a bounded regular JSON file.');
  const draft = JSON.parse(await readFile(draftPath, 'utf8'));
  check(draft.schemaVersion === 1 && draft.purpose === 'se-widget-studio-draft', 'Draft has an unsupported format.');
  check(draft.origin === access.origin && draft.projectId === access.projectId && ID.test(draft.revisionId), 'Draft belongs to a different project or origin.');
  check(typeof draft.etag === 'string' && draft.etag.length > 0 && draft.snapshot && typeof draft.snapshot === 'object', 'Draft is missing its snapshot or concurrency metadata.');
  await checkSampleMedia(access.origin, draft.snapshot, {action: 'pushed'});
  const result = await api(access.origin, `/api/v1/projects/${access.projectId}`, {method: 'PUT', token: access.token, headers: {'If-Match': draft.etag}, body: draft.snapshot});
  if (result.status === 409) fail('Push conflict (HTTP 409). Pull a fresh draft and reconcile instead of overwriting the newer revision.');
  const view = expect(result, [200], 'Project replacement');
  console.log(JSON.stringify({status: view.revision.status, projectId: access.projectId, revisionId: view.revision.id, diagnostics: view.revision.diagnostics}));
}

async function openEditor(flags) {
  const access = await readPrivate(required(flags, '--access'), {purposes: [ACCESS_PURPOSE, VERIFICATION_PURPOSE]});
  const url = new URL(access.editorUrl, access.origin);
  check(url.origin === access.origin && url.pathname === `/p/${access.projectId}` && url.hash.startsWith('#key='), 'Editor URL is invalid.');
  let command; let args;
  if (platform() === 'darwin') {command = 'open'; args = [url.href];}
  else if (platform() === 'win32') {command = 'cmd'; args = ['/c', 'start', '', url.href];}
  else {command = 'xdg-open'; args = [url.href];}
  const child = spawn(command, args, {detached: true, stdio: 'ignore'});
  await new Promise((done, reject) => {child.once('spawn', done); child.once('error', reject);});
  child.unref();
  console.log(JSON.stringify({status: 'opened', projectId: access.projectId}));
}

async function ensureOutputAbsent(path) {
  const target = resolve(path);
  try {await lstat(target); fail('Output directory already exists. Select a new directory; nothing was overwritten.');}
  catch (error) {if (error?.code !== 'ENOENT') throw error;}
  await mkdir(dirname(target), {recursive: true});
  return target;
}

async function downloadArtifact(access, artifact) {
  check(typeof artifact.id === 'string' && /^[a-zA-Z0-9_-]{1,150}$/.test(artifact.id), 'Artifact ID is invalid.');
  check(Number.isSafeInteger(artifact.bytes) && artifact.bytes > 0 && artifact.bytes <= originLimits(access.origin).artifact && /^[a-f0-9]{64}$/.test(artifact.sha256), 'Artifact metadata is invalid.');
  let response = await studioFetch(new URL(`/api/studio/projects/${access.projectId}/artifacts/${artifact.id}`, access.origin), {redirect: 'manual', signal: AbortSignal.timeout(60_000), headers: {Authorization: `Bearer ${access.token}`}});
  if (response.status === 307) {
    const destination = new URL(response.headers.get('location') ?? '');
    check(destination.protocol === 'https:' && !destination.username && !destination.password, 'Signed artifact URL must use HTTPS without URL credentials.');
    response = await fetch(destination, {redirect: 'error', signal: AbortSignal.timeout(60_000)});
  }
  check(response.status === 200, `Artifact download failed with HTTP ${response.status}.`);
  const bytes = await boundedBody(response, artifact.bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  check(bytes.length === artifact.bytes && sha256 === artifact.sha256, 'Artifact byte count or SHA-256 did not match its metadata.');
  return {bytes, sha256};
}

/** The `fonts.issues` of a render manifest or test report, so a font warning is not left unread in the files. */
export function fontIssues(name, bytes) {
  if (!/(?:^|[/\\])(?:manifest|test-report)\.json$/.test(String(name))) return [];
  try {
    const issues = JSON.parse(Buffer.from(bytes).toString('utf8'))?.fonts?.issues;
    return Array.isArray(issues) ? issues.filter(issue => typeof issue === 'string') : [];
  } catch {return [];}
}

async function runJob(flags) {
  const access = await readPrivate(required(flags, '--access'));
  const kind = required(flags, '--kind'); const selection = required(flags, '--selection');
  check(['test', 'render'].includes(kind), '--kind must be test or render.');
  check(ID.test(selection) || /^(scene|video):[a-zA-Z0-9_-]{1,100}$/.test(selection), '--selection must be all, a catalog ID, scene:<id>, or video:<id>.');
  const output = await ensureOutputAbsent(required(flags, '--output-dir'));
  const created = expect(await api(access.origin, `/api/studio/projects/${access.projectId}/jobs`, {method: 'POST', token: access.token, body: {kind, selection}}), [202], 'Job submission');
  check(ID.test(created.id), 'Job submission returned an invalid ID.');
  let job = created; let lastProgress = '';
  const {jobMs} = originLimits(access.origin);
  const deadline = Math.min(Date.now() + jobMs, Date.parse(job.createdAt) + jobMs);
  check(Number.isFinite(deadline), 'Job creation time is invalid.');
  while (!['completed', 'failed', 'cancelled'].includes(job.status)) {
    if (job.progress !== lastProgress) {process.stderr.write(`[se-widget-studio] ${job.status}: ${job.progress}\n`); lastProgress = job.progress;}
    check(Date.now() < deadline, 'Polling reached the job deadline. Use status before deciding whether to submit another job.');
    await sleep(Math.min(5000, Math.max(1, deadline - Date.now())));
    // The job's own route reads one record; the job list reads every job the project ever ran.
    const polled = await api(access.origin, `/api/studio/projects/${access.projectId}/jobs/${created.id}`, {token: access.token});
    check(polled.status !== 404, 'Accepted job disappeared from the project.');
    job = expect(polled, [200], 'Job poll');
    check(job?.id === created.id, 'Job poll returned a different job.');
  }
  check(job.status === 'completed', `Job ended with ${job.status}. ${job.error ?? ''}`);
  await mkdir(output, {recursive: false, mode: 0o700});
  const artifacts = [];
  const fonts = new Set();
  for (const [index, artifact] of job.artifacts.entries()) {
    const downloaded = await downloadArtifact(access, artifact);
    const safe = basename(String(artifact.name)).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'artifact';
    const file = `${String(index).padStart(3, '0')}-${safe}`;
    await writeFile(resolve(output, file), downloaded.bytes, {flag: 'wx', mode: 0o600});
    artifacts.push({id: artifact.id, file, contentType: artifact.contentType, bytes: downloaded.bytes.length, sha256: downloaded.sha256});
    for (const issue of fontIssues(artifact.name, downloaded.bytes)) fonts.add(issue);
  }
  const fontSummary = fonts.size ? {fontIssues: [...fonts]} : {};
  if (fonts.size) process.stderr.write(`[se-widget-studio] Google Fonts issues: ${[...fonts].join(' | ')}\n`);
  const report = {schemaVersion: 1, origin: access.origin, projectId: access.projectId, jobId: job.id, revisionId: job.revisionId, kind, selection, status: job.status, artifacts, ...fontSummary};
  await writeFile(resolve(output, 'job.json'), JSON.stringify(report, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  console.log(JSON.stringify({status: job.status, projectId: access.projectId, jobId: job.id, output, artifacts, ...fontSummary}));
}

function help() {
  console.log(`SE Widget Studio client

Usage:
  studio-client.mjs import --widget-root <absolute-dir> [--name <name>] [--catalog <json>] [--origin <url>] [--access-out <private-json>]
  studio-client.mjs import --config <se-widget-studio.config.mjs> [--recipes <id,...>] [--name <name>] [--origin <url>] [--access-out <private-json>]
  studio-client.mjs catalog --config <se-widget-studio.config.mjs> [--recipes <id,...>] --out <new-json>
  studio-client.mjs status --access <private-json>
  studio-client.mjs open-editor --access <private-json>
  studio-client.mjs pull --access <private-json> --draft-out <new-json>
  studio-client.mjs push --access <private-json> --draft <json>
  studio-client.mjs run --access <private-json> --kind <test|render> --selection <id|all|scene:id|video:id> --output-dir <new-dir>

The default origin is ${DEFAULT_ORIGIN}, the local Studio that \`npm run serve\` starts in the Studio checkout.
Set SE_WIDGET_STUDIO_URL or pass --origin to select another Studio.
Creation reads STUDIO_CREATE_KEY from the environment when configured. Capabilities are never printed.
Open-editor also accepts the access.private.json that scripts/verify-hosted.mjs writes; no other command does.
Import reads but never modifies production widget files. Pull/push use complete snapshots and optimistic concurrency.
--config reads a local Studio config with the engine of the Studio checkout this client belongs to, as the local CLI does:
catalog globs become arrays, the files the local Studio serves become private uploads, and /__sws/widget/<path> values
become <path>. A test image that copies a built-in sample becomes its sws-sample: reference instead of an upload, unless
the widget source references it. --recipes keeps only those recipes and the scenes, themes, and fixtures they use, and
leaves scenarios out.
Catalog writes that flattened catalog, the JSON that import --catalog takes, without contacting any Studio.
Import and push check sws-sample: references against the selected deployment before any change; a blocked import prints its diagnostics.
Run refuses an existing output directory, polls one job, verifies artifact hashes, and never forwards bearer authorization to Blob.`);
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  if (!command || command === '--help' || command === '-h') return help();
  if (command === 'import') return importWidget(parseFlags(args, new Set(['--widget-root', '--name', '--catalog', '--config', '--recipes', '--origin', '--access-out'])));
  if (command === 'catalog') return writeCatalog(parseFlags(args, new Set(['--config', '--recipes', '--out'])));
  if (command === 'status') return status(parseFlags(args, new Set(['--access'])));
  if (command === 'open-editor') return openEditor(parseFlags(args, new Set(['--access'])));
  if (command === 'pull') return pull(parseFlags(args, new Set(['--access', '--draft-out'])));
  if (command === 'push') return push(parseFlags(args, new Set(['--access', '--draft'])));
  if (command === 'run') return runJob(parseFlags(args, new Set(['--access', '--kind', '--selection', '--output-dir'])));
  fail(`Unknown command ${command}. Run with --help.`);
}

// Node resolves symlinks for the ESM entry point, so import.meta.url is the real path while
// argv[1] keeps the linked path an installed skill is invoked through. Compare real paths.
function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().catch(error => {console.error(error instanceof Error ? error.message : 'Studio operation failed.'); process.exitCode = 1;});
}
