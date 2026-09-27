// Google Fonts proxy for trusted server code: bounded upstream fetch, append-only content-addressed
// cache, short-lived negative cache for upstream 4xx, daily budget, and per-revision font locks.
// This is the only code allowed to reach Google (AGENTS.md). Widget code never calls it directly.
import {createHash} from 'node:crypto';
import {parse as parseHtml} from 'parse5';
import postcss from 'postcss';
import type {ObjectStore, PreparedSnapshot, WidgetSnapshot} from './model';
import type {JsonObject} from '../src/types';
import {substitutePlaceholders} from '../src/config/placeholders';
import {previewState} from './preview';
import {ConflictError} from './errors';
import {ImmutableReadCache, mutateJson, readJson, writeJson} from './storage';
import {attribute, elements, fetchPublicAsset, protectPlaceholders, PublicFetchError, textContent, type PublicLookup, type PublicTransport} from './importer';
import {safeId} from './schema';
import {
  FONT_CACHE_EPOCH,
  GOOGLE_FONTS_CSS_HOST,
  GOOGLE_FONTS_FILE_HOST,
  GOOGLE_FONTS_MAX_CSS_BYTES,
  GOOGLE_FONTS_MAX_FONT_BYTES,
  GOOGLE_FONTS_UA,
  canonicalGoogleFontsUrl,
  type GoogleFontsUrlKind
} from '../src/runtime/google-fonts-url';
import {sniffFont, validateGoogleCss, type FontFileFormat, type GoogleFontFile} from '../src/fonts/css';

export type FontBucket = 'render' | 'preview';
/** Upstream GETs per UTC day. Separate buckets, so the editor cannot starve renders. */
export const FONT_BUDGET_LIMITS: Readonly<Record<FontBucket, number>> = {render: 3000, preview: 1500};
export const FONT_NEGATIVE_TTL_MS = 60 * 60 * 1000;
/** Files downloaded eagerly when a stylesheet enters the cache. Above either limit the entry is `partial`. */
export const FONT_EAGER_MAX_FILES = 64;
export const FONT_EAGER_MAX_BYTES = 8 * 1024 * 1024;
export const FONT_LOCK_MAX_ENTRIES = 512;
const EAGER_CONCURRENCY = 4;
const DEFAULT_DEADLINE_MS = 20_000;
const FONT_CONTENT_TYPES: Record<FontFileFormat, string> = {woff2: 'font/woff2', woff: 'font/woff', otf: 'font/otf', ttf: 'font/ttf', ttc: 'font/collection'};

const sha256 = (body: Uint8Array | string): string => createHash('sha256').update(body).digest('hex');
const isSha256 = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

export const fontObjectKey = (digest: string): string => `fonts/v1/objects/${digest}`;
const cacheId = (epoch: string, userAgent: string, url: string): string => sha256(`${epoch}|${userAgent}|${url}`);
export const fontIndexKey = (epoch: string, userAgent: string, url: string): string => `fonts/v1/index/${cacheId(epoch, userAgent, url)}.json`;
export const fontNegativeKey = (epoch: string, userAgent: string, url: string): string => `fonts/v1/negative/${cacheId(epoch, userAgent, url)}.json`;
export const fontUsageKey = (now: number): string => `usage/fonts-${new Date(now).toISOString().slice(0, 10)}.json`;
const lockPrefix = (projectId: string, revisionId: string): string => `projects/${safeId(projectId)}/fontlocks/${safeId(revisionId)}/`;
const lockKey = (projectId: string, revisionId: string, url: string): string => `${lockPrefix(projectId, revisionId)}${sha256(url)}.json`;

/** Write-once URL index entry: canonical URL to content-addressed object. */
export interface FontIndexEntry {
  version: 1; url: string; epoch: string; userAgent: string; kind: GoogleFontsUrlKind;
  sha256: string; bytes: number; contentType: string; createdAt: string;
  /** Validated address the bytes came from. */
  address?: string;
  /** Stylesheets only: every file the CSS lists, in order. */
  files?: string[];
  /** Stylesheets only: some listed files were not downloaded eagerly; fetch them individually. */
  partial?: boolean;
}
interface NegativeEntry {url: string; status: number; message: string; expiresAt: number}
/** One URL a revision has used. `status` is 200 for cached bytes, or the upstream 4xx it received. */
export interface FontLockEntry {url: string; status: number; sha256?: string; bytes?: number; contentType?: string}

export type FontUnavailableReason = 'unsupported' | 'upstream' | 'budget' | 'invalid' | 'integrity' | 'lock';
export type FontResolution =
  | {status: 'ok'; url: string; kind: GoogleFontsUrlKind; sha256: string; bytes: number; contentType: string; body: Uint8Array; source: 'lock' | 'cache' | 'upstream'; files?: readonly string[]; partial?: boolean}
  | {status: 'upstream-4xx'; url: string; httpStatus: number; message: string; source: 'lock' | 'negative' | 'upstream' | 'local'}
  | {status: 'unavailable'; code: 'FONT_UNAVAILABLE' | 'FONT_UNSUPPORTED'; url: string; reason: FontUnavailableReason; message: string};

/** Per-instance memory: immutable-read LRU and single-flight of in-progress resolves. */
export class FontMemory {
  readonly reads: ImmutableReadCache;
  readonly flights = new WeakMap<ObjectStore, Map<string, Promise<FontResolution>>>();
  constructor(reads = new ImmutableReadCache()) { this.reads = reads; }
}
const sharedMemory = new FontMemory();

export interface ResolveGoogleFontOptions {
  store: ObjectStore;
  bucket: FontBucket;
  /** Pinned per revision; defaults to the current global values. */
  epoch?: string;
  userAgent?: string;
  /** Text the widget shows; picks the files downloaded first when a stylesheet lists many. */
  sampleText?: string;
  /** Records the outcome in this revision's font lock and replays what the lock already holds. */
  lock?: {projectId: string; revisionId: string};
  /** Absolute epoch milliseconds for every upstream request of this resolve. Default now + 20 s. */
  deadline?: number;
  /** Clock for negative-cache expiry and the budget day. */
  now?: () => number;
  budgetLimits?: Partial<Record<FontBucket, number>>;
  memory?: FontMemory;
  lookup?: PublicLookup;
  transport?: PublicTransport;
}

interface Context {
  store: ObjectStore; bucket: FontBucket; epoch: string; userAgent: string; sampleText: string;
  deadline: number; now: () => number; limits: Record<FontBucket, number>; memory: FontMemory;
  lookup: PublicLookup | undefined; transport: PublicTransport | undefined;
}

const unavailable = (url: string, reason: FontUnavailableReason, message: string): FontResolution => ({status: 'unavailable', code: reason === 'unsupported' ? 'FONT_UNSUPPORTED' : 'FONT_UNAVAILABLE', url, reason, message});

/**
 * Resolves one Google Fonts stylesheet or font file URL through the cache, fetching it upstream
 * only on a miss. Returns `ok`, `upstream-4xx` (Google refused it; the text stays in fallback) or
 * `unavailable` (not cached and not fetchable now: upstream down, budget, invalid content).
 * Storage failures are thrown, not reported as `unavailable`.
 */
export async function resolveGoogleFont(input: string, options: ResolveGoogleFontOptions): Promise<FontResolution> {
  const canonical = canonicalGoogleFontsUrl(input);
  if (!canonical.ok) {
    if (canonical.code === 'FONT_BAD_REQUEST') return {status: 'upstream-4xx', url: input, httpStatus: canonical.status ?? 400, message: canonical.message, source: 'local'};
    return unavailable(input, 'unsupported', canonical.message);
  }
  const now = options.now ?? Date.now;
  const ctx: Context = {
    store: options.store, bucket: options.bucket, epoch: options.epoch ?? FONT_CACHE_EPOCH, userAgent: options.userAgent ?? GOOGLE_FONTS_UA,
    sampleText: options.sampleText ?? '', deadline: options.deadline ?? Date.now() + DEFAULT_DEADLINE_MS, now,
    limits: {...FONT_BUDGET_LIMITS, ...options.budgetLimits}, memory: options.memory ?? sharedMemory,
    lookup: options.lookup, transport: options.transport
  };
  const {url, kind} = canonical;
  if (options.lock) {
    const recorded = await readLockEntry(ctx.store, options.lock.projectId, options.lock.revisionId, url);
    if (recorded) return replayLockEntry(ctx, recorded, kind);
  }
  const result = await singleFlight(ctx, fontIndexKey(ctx.epoch, ctx.userAgent, url), () => resolveShared(ctx, url, kind));
  if (options.lock) {
    const entry = lockEntryFor(result);
    if (entry && await writeLockEntry(ctx.store, options.lock.projectId, options.lock.revisionId, entry) === 'full') {
      return unavailable(url, 'lock', `This revision already uses ${FONT_LOCK_MAX_ENTRIES} Google Fonts URLs, the per-revision limit.`);
    }
  }
  return result;
}

function singleFlight(ctx: Context, key: string, run: () => Promise<FontResolution>): Promise<FontResolution> {
  let flights = ctx.memory.flights.get(ctx.store);
  if (!flights) { flights = new Map(); ctx.memory.flights.set(ctx.store, flights); }
  const pending = flights.get(key);
  if (pending) return pending;
  const flight = run().finally(() => flights.delete(key));
  flights.set(key, flight);
  return flight;
}

async function resolveShared(ctx: Context, url: string, kind: GoogleFontsUrlKind): Promise<FontResolution> {
  const cached = await readIndex(ctx, url);
  if (cached) return fromIndex(ctx, cached, 'cache');
  const refused = await readNegative(ctx, url);
  if (refused) return refused;
  if (!await reserveFontBudget(ctx.store, ctx.bucket, 1, {now: ctx.now(), limits: ctx.limits})) return budgetExhausted(ctx, url);
  const fetched = await fetchUpstream(ctx, url, kind);
  if ('status' in fetched) return fetched;
  if (kind === 'font') return storeEntry(ctx, url, 'font', fetched.body, fetched.contentType, {address: fetched.address});
  const validation = validateGoogleCss(fetched.body);
  if (!validation.ok) return unavailable(url, 'invalid', `Google Fonts returned a stylesheet the Studio does not accept: ${validation.message}`);
  const files = unique(validation.files.map(file => file.url));
  const partial = await downloadEagerly(ctx, validation.files);
  return storeEntry(ctx, url, 'css', fetched.body, 'text/css', {address: fetched.address, files, partial});
}

type Fetched = {body: Buffer; contentType: string; address: string};
async function fetchUpstream(ctx: Context, url: string, kind: GoogleFontsUrlKind): Promise<Fetched | FontResolution> {
  try {
    const response = await fetchPublicAsset(url, {
      maxRedirects: 0,
      deadline: ctx.deadline,
      headers: {'User-Agent': ctx.userAgent, Accept: kind === 'css' ? 'text/css,*/*;q=0.1' : '*/*'},
      maxBytes: kind === 'css' ? GOOGLE_FONTS_MAX_CSS_BYTES : GOOGLE_FONTS_MAX_FONT_BYTES,
      allowedHosts: [GOOGLE_FONTS_CSS_HOST, GOOGLE_FONTS_FILE_HOST],
      preferIpv4: true,
      ...(ctx.lookup ? {lookup: ctx.lookup} : {}),
      ...(ctx.transport ? {transport: ctx.transport} : {})
    });
    if (kind === 'css') return {body: response.body, contentType: 'text/css', address: response.address};
    const format = sniffFont(response.body);
    if (!format) return unavailable(url, 'invalid', 'Google Fonts returned a font file whose bytes are not a font.');
    return {body: response.body, contentType: FONT_CONTENT_TYPES[format], address: response.address};
  } catch (error) {
    if (!(error instanceof PublicFetchError)) throw error;
    const status = error.status;
    // A 4xx is Google refusing the request (unknown family, bad axis): cache it briefly, outside the
    // index. 408 and 429 are transient, and 5xx or transport failures are never cached.
    if (error.kind === 'status' && status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429) {
      const message = `Google Fonts answered HTTP ${status} for ${url}.`;
      const entry: NegativeEntry = {url, status, message, expiresAt: ctx.now() + FONT_NEGATIVE_TTL_MS};
      await writeJson(ctx.store, fontNegativeKey(ctx.epoch, ctx.userAgent, url), entry, {overwrite: true});
      return {status: 'upstream-4xx', url, httpStatus: status, message, source: 'upstream'};
    }
    return unavailable(url, 'upstream', `Google Fonts could not be reached for ${url}: ${error.message}`);
  }
}

async function storeEntry(ctx: Context, url: string, kind: GoogleFontsUrlKind, body: Buffer, contentType: string, extra: Pick<FontIndexEntry, 'address' | 'files' | 'partial'>): Promise<FontResolution> {
  const digest = sha256(body);
  try { await ctx.store.put(fontObjectKey(digest), body, {contentType}); }
  catch (error) { if (!(error instanceof ConflictError)) throw error; } // Content-addressed: the same bytes are already there.
  const entry: FontIndexEntry = {version: 1, url, epoch: ctx.epoch, userAgent: ctx.userAgent, kind, sha256: digest, bytes: body.byteLength, contentType, createdAt: new Date(ctx.now()).toISOString()};
  if (extra.address) entry.address = extra.address;
  if (extra.files) entry.files = extra.files;
  if (extra.partial) entry.partial = true;
  try {
    await writeJson(ctx.store, fontIndexKey(ctx.epoch, ctx.userAgent, url), entry);
  } catch (error) {
    if (!(error instanceof ConflictError)) throw error;
    // Another instance indexed this URL first. The index is write-once: serve the winner.
    const winner = await readIndex(ctx, url);
    if (!winner) throw error;
    return fromIndex(ctx, winner, 'cache');
  }
  return {status: 'ok', url, kind, sha256: digest, bytes: body.byteLength, contentType, body, source: 'upstream', ...(entry.files ? {files: entry.files} : {}), ...(entry.partial ? {partial: true} : {})};
}

async function readIndex(ctx: Context, url: string): Promise<FontIndexEntry | undefined> {
  const raw = await ctx.memory.reads.read(ctx.store, fontIndexKey(ctx.epoch, ctx.userAgent, url));
  if (!raw) return undefined;
  const entry = JSON.parse(Buffer.from(raw).toString('utf8')) as FontIndexEntry;
  if (entry.url !== url || !isSha256(entry.sha256) || !Number.isSafeInteger(entry.bytes)) throw new Error(`Corrupt Google Fonts index entry for ${url}.`);
  return entry;
}

/** Reads a content-addressed object and checks its SHA-256 and size on every read. */
async function readObject(ctx: Context, digest: string, bytes: number | undefined): Promise<Uint8Array | undefined> {
  const body = await ctx.memory.reads.read(ctx.store, fontObjectKey(digest));
  if (!body || sha256(body) !== digest || (bytes !== undefined && body.byteLength !== bytes)) return undefined;
  return body;
}

async function fromIndex(ctx: Context, entry: FontIndexEntry, source: 'cache' | 'lock'): Promise<FontResolution> {
  const body = await readObject(ctx, entry.sha256, entry.bytes);
  if (!body) return unavailable(entry.url, 'integrity', `The cached Google Fonts object for ${entry.url} is missing or failed its SHA-256 check.`);
  return {status: 'ok', url: entry.url, kind: entry.kind, sha256: entry.sha256, bytes: entry.bytes, contentType: entry.contentType, body, source, ...(entry.files ? {files: entry.files} : {}), ...(entry.partial ? {partial: true} : {})};
}

async function readNegative(ctx: Context, url: string): Promise<FontResolution | undefined> {
  const entry = await readJson<NegativeEntry>(ctx.store, fontNegativeKey(ctx.epoch, ctx.userAgent, url));
  if (!entry || entry.url !== url || !(entry.expiresAt > ctx.now())) return undefined;
  return {status: 'upstream-4xx', url, httpStatus: entry.status, message: entry.message, source: 'negative'};
}

function budgetExhausted(ctx: Context, url: string): FontResolution {
  return unavailable(url, 'budget', `The daily Google Fonts ${ctx.bucket} budget (${ctx.limits[ctx.bucket]} upstream requests) is exhausted; ${url} is not cached.`);
}

class FontBudgetExceeded extends Error {}

/**
 * Reserves `amount` upstream requests in one compare-and-swap, for a whole batch (one stylesheet,
 * its eager files, or one refill pass). A bucket missing from the day's record starts at 0.
 */
export async function reserveFontBudget(store: ObjectStore, bucket: FontBucket, amount: number, options: {now?: number; limits?: Partial<Record<FontBucket, number>>} = {}): Promise<boolean> {
  if (!(amount > 0)) return true;
  const limit = {...FONT_BUDGET_LIMITS, ...options.limits}[bucket];
  try {
    await mutateJson<Partial<Record<FontBucket, number>>>(store, fontUsageKey(options.now ?? Date.now()), {render: 0, preview: 0}, value => {
      const recorded = value[bucket];
      const used = typeof recorded === 'number' && Number.isFinite(recorded) ? recorded : 0;
      if (used + amount > limit) throw new FontBudgetExceeded();
      return {...value, [bucket]: used + amount};
    });
    return true;
  } catch (error) {
    if (error instanceof FontBudgetExceeded) return false;
    throw error;
  }
}

/**
 * Downloads the files a new stylesheet lists, up to FONT_EAGER_MAX_FILES files and
 * FONT_EAGER_MAX_BYTES bytes, files covering the sample text and Basic Latin first. Above the file
 * limit only covering files are fetched. Returns true when some listed file was not cached (`partial`).
 */
async function downloadEagerly(ctx: Context, files: readonly GoogleFontFile[]): Promise<boolean> {
  const all = unique(files.map(file => file.url));
  if (!all.length) return false;
  const points = samplePoints(ctx.sampleText);
  const covering = unique(files.filter(file => coversAny(file.unicodeRange, points)).map(file => file.url));
  let partial = all.length > FONT_EAGER_MAX_FILES;
  const selected = partial ? covering.slice(0, FONT_EAGER_MAX_FILES) : unique([...covering, ...all]);
  if (selected.length < all.length) partial = true;
  const missing: string[] = [];
  for (const url of selected) if (!await readIndex(ctx, url)) missing.push(url);
  if (!missing.length) return partial;
  if (!await reserveFontBudget(ctx.store, ctx.bucket, missing.length, {now: ctx.now(), limits: ctx.limits})) return true;
  let total = 0;
  let full = false;
  const queue = [...missing];
  const worker = async () => {
    for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
      if (full) { partial = true; continue; }
      const fetched = await fetchUpstream(ctx, url, 'font');
      if ('status' in fetched) { partial = true; continue; }
      if (total + fetched.body.byteLength > FONT_EAGER_MAX_BYTES) { full = true; partial = true; continue; }
      total += fetched.body.byteLength;
      const stored = await storeEntry(ctx, url, 'font', fetched.body, fetched.contentType, {address: fetched.address});
      if (stored.status !== 'ok') partial = true;
    }
  };
  await Promise.all(Array.from({length: Math.min(EAGER_CONCURRENCY, missing.length)}, worker));
  return partial;
}

function samplePoints(text: string): Set<number> {
  const points = new Set<number>();
  for (let code = 0x20; code <= 0x7e; code++) points.add(code);
  for (const char of text) points.add(char.codePointAt(0)!);
  return points;
}

/** Whether a CSS `unicode-range` covers any of the points. No range means the whole of Unicode. */
export function coversAny(range: string | undefined, points: ReadonlySet<number>): boolean {
  if (!range || !range.trim()) return true;
  for (const part of range.split(',')) {
    const match = /^\s*u\+([0-9a-f?]{1,6})(?:-([0-9a-f]{1,6}))?\s*$/i.exec(part);
    if (!match) continue;
    const start = match[1]!;
    const low = Number.parseInt(start.replace(/\?/g, '0'), 16);
    const high = match[2] ? Number.parseInt(match[2], 16) : Number.parseInt(start.replace(/\?/g, 'f'), 16);
    for (const point of points) if (point >= low && point <= high) return true;
  }
  return false;
}

const unique = (values: readonly string[]): string[] => [...new Set(values)];

// Per-revision lock ---------------------------------------------------------------------------

const isLockEntry = (value: unknown): value is FontLockEntry => {
  const entry = value as FontLockEntry | null;
  return typeof entry === 'object' && entry !== null && typeof entry.url === 'string' && Number.isInteger(entry.status)
    && (entry.status === 200 ? isSha256(entry.sha256) && Number.isSafeInteger(entry.bytes) && typeof entry.contentType === 'string' : entry.status >= 400 && entry.status < 500);
};

/** The lock entry a resolution produces, or undefined for transient outcomes that must not be pinned. */
export function lockEntryFor(resolution: FontResolution): FontLockEntry | undefined {
  if (resolution.status === 'ok') return {url: resolution.url, status: 200, sha256: resolution.sha256, bytes: resolution.bytes, contentType: resolution.contentType};
  if (resolution.status === 'upstream-4xx' && resolution.source !== 'local') return {url: resolution.url, status: resolution.httpStatus};
  return undefined;
}

/**
 * Writes one URL into a revision's lock. One object per URL, never overwritten, so concurrent
 * writers do not contend and a repeated write is a no-op.
 */
export async function writeLockEntry(store: ObjectStore, projectId: string, revisionId: string, entry: FontLockEntry): Promise<'written' | 'exists' | 'full'> {
  if (!isLockEntry(entry)) throw new Error('Invalid font lock entry.');
  const key = lockKey(projectId, revisionId, entry.url);
  if (await store.get(key)) return 'exists';
  if ((await store.list(lockPrefix(projectId, revisionId))).length >= FONT_LOCK_MAX_ENTRIES) return 'full';
  const normalized: FontLockEntry = entry.status === 200 ? {url: entry.url, status: 200, sha256: entry.sha256!, bytes: entry.bytes!, contentType: entry.contentType!} : {url: entry.url, status: entry.status};
  try { await writeJson(store, key, normalized); return 'written'; }
  catch (error) { if (error instanceof ConflictError) return 'exists'; throw error; }
}

export async function readLockEntry(store: ObjectStore, projectId: string, revisionId: string, url: string): Promise<FontLockEntry | undefined> {
  const entry = await readJson<unknown>(store, lockKey(projectId, revisionId, url));
  return isLockEntry(entry) && entry.url === url ? entry : undefined;
}

/** Every URL the revision has used, sorted by URL. */
export async function lockForRevision(store: ObjectStore, projectId: string, revisionId: string): Promise<FontLockEntry[]> {
  const keys = (await store.list(lockPrefix(projectId, revisionId))).filter(key => key.endsWith('.json'));
  const entries = await Promise.all(keys.map(key => readJson<unknown>(store, key)));
  return entries.filter(isLockEntry).sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
}

/** Order-independent digest of what a render served: URL, status and SHA-256 of each entry. */
export function servedDigest(entries: readonly FontLockEntry[]): string {
  const lines = entries.map(entry => JSON.stringify([entry.url, entry.status, entry.sha256 ?? null])).sort();
  return sha256(lines.join('\n'));
}

/** Copies a revision's lock to another revision (restore). Objects are content-addressed, so only entries move. */
export async function copyFontLock(store: ObjectStore, projectId: string, fromRevisionId: string, toRevisionId: string): Promise<number> {
  let copied = 0;
  for (const entry of await lockForRevision(store, projectId, fromRevisionId)) {
    const outcome = await writeLockEntry(store, projectId, toRevisionId, entry);
    if (outcome === 'full') throw new Error(`Font lock copy exceeded ${FONT_LOCK_MAX_ENTRIES} entries.`);
    if (outcome === 'written') copied++;
  }
  return copied;
}

async function replayLockEntry(ctx: Context, entry: FontLockEntry, kind: GoogleFontsUrlKind): Promise<FontResolution> {
  if (entry.status !== 200) return {status: 'upstream-4xx', url: entry.url, httpStatus: entry.status, message: `Google Fonts answered HTTP ${entry.status} for ${entry.url} when this revision first used it.`, source: 'lock'};
  const body = await readObject(ctx, entry.sha256!, entry.bytes);
  if (!body) return unavailable(entry.url, 'integrity', `The Google Fonts object pinned by this revision for ${entry.url} is missing or failed its SHA-256 check.`);
  let files: string[] | undefined;
  if (kind === 'css') {
    const validation = validateGoogleCss(body);
    if (!validation.ok) return unavailable(entry.url, 'invalid', validation.message);
    files = unique(validation.files.map(file => file.url));
  }
  return {status: 'ok', url: entry.url, kind, sha256: entry.sha256!, bytes: body.byteLength, contentType: entry.contentType!, body, source: 'lock', ...(files ? {files} : {})};
}

// ---------------------------------------------------------------------------------------------
// Prewarm on save: the Google stylesheets a revision can be known to use without running it.

/** Stylesheets resolved per save; the rest wait for the first job that needs them. */
export const FONT_PREWARM_MAX_URLS = 8;

const IMPORT_REFERENCE = /^(?:url\(\s*)?(?:"([^"]*)"|'([^']*)'|([^\s)'";]+))/i;
/** `@import` references; placeholders a field did not fill are protected, and CSS a value broke is scanned instead. */
const cssImports = (css: string): string[] => {
  const {text, restore} = protectPlaceholders(css);
  const found: string[] = [];
  try {
    postcss.parse(text).walkAtRules('import', rule => {
      const match = IMPORT_REFERENCE.exec(rule.params);
      const reference = match?.[1] ?? match?.[2] ?? match?.[3];
      if (reference) found.push(restore(reference));
    });
  } catch {
    for (const match of css.matchAll(/@import\s+((?:url\(\s*)?(?:"[^"]*"|'[^']*'|[^\s)'";]+))/gi)) {
      const inner = IMPORT_REFERENCE.exec(match[1] ?? '');
      const reference = inner?.[1] ?? inner?.[2] ?? inner?.[3];
      if (reference) found.push(reference);
    }
  }
  return found;
};

/**
 * Canonical Google Fonts stylesheet URLs from static `<link rel="stylesheet">` and `@import` in the
 * widget HTML and CSS, after `{{field}}` substitution with the defaults and with each theme and
 * scene, plus stylesheets the importer captured. URLs that still hold a placeholder are skipped.
 */
export function staticGoogleFontUrls(source: WidgetSnapshot, prepared?: PreparedSnapshot): string[] {
  const states: JsonObject[] = [];
  const add = (options: {themeId?: string; sceneId?: string}) => { try { states.push(previewState(source, {sessionId: 'prewarm', ...options}).fieldData); } catch { /* a dangling theme or scene reference is reported elsewhere */ } };
  add({});
  for (const theme of source.themes) add({themeId: theme.id});
  for (const scene of source.scenes) add({sceneId: scene.id});
  const references: string[] = [];
  for (const fieldData of states) {
    const html = substitutePlaceholders(source.widget.html, fieldData).text;
    for (const node of elements(parseHtml(html))) {
      if (node.tagName === 'link' && attribute(node, 'rel')?.toLowerCase() === 'stylesheet') { const href = attribute(node, 'href'); if (href) references.push(href); }
      if (node.tagName === 'style') references.push(...cssImports(textContent(node)));
    }
    references.push(...cssImports(substitutePlaceholders(source.widget.css, fieldData).text));
  }
  for (const asset of prepared?.assets ?? []) if (asset.sourceUrl) references.push(asset.sourceUrl);
  const urls: string[] = [];
  for (const reference of references) {
    const canonical = canonicalGoogleFontsUrl(reference.trim());
    if (canonical.ok && canonical.kind === 'css' && !urls.includes(canonical.url)) urls.push(canonical.url);
  }
  return urls;
}

export interface PrewarmOptions extends Pick<ResolveGoogleFontOptions, 'memory' | 'lookup' | 'transport' | 'now' | 'budgetLimits'> {
  store: ObjectStore;
  projectId: string;
  revisionId: string;
  epoch: string;
  userAgent: string;
  /** Absolute epoch milliseconds. Nothing starts after it. */
  deadline: number;
}

/**
 * Resolves up to FONT_PREWARM_MAX_URLS stylesheets into the cache and the revision's lock, in the
 * `preview` budget bucket. Never throws: every failure is returned as a warning for `diagnostics`.
 */
export async function prewarmGoogleFonts(urls: readonly string[], options: PrewarmOptions): Promise<string[]> {
  const warnings: string[] = [];
  const selected = urls.slice(0, FONT_PREWARM_MAX_URLS);
  if (urls.length > selected.length) warnings.push(`${urls.length - selected.length} more Google Fonts stylesheets were not prewarmed (${FONT_PREWARM_MAX_URLS} per save); jobs fetch them when needed.`);
  if (Date.now() >= options.deadline) {
    if (selected.length) warnings.push(`Google Fonts prewarm skipped ${selected.length} stylesheets: no time was left in this save.`);
    return warnings;
  }
  const {store, projectId, revisionId, epoch, userAgent, deadline, ...inject} = options;
  const outcomes = await Promise.all(selected.map(async url => {
    try {
      const result = await resolveGoogleFont(url, {...inject, store, bucket: 'preview', epoch, userAgent, deadline, lock: {projectId, revisionId}});
      if (result.status === 'upstream-4xx') return `Google Fonts refused ${url} (HTTP ${result.httpStatus}); that text stays in a fallback font, as in StreamElements.`;
      if (result.status === 'unavailable') return `Google Fonts prewarm could not cache ${url}: ${result.message} Jobs try again when they need it.`;
      return undefined;
    } catch (error) {
      return `Google Fonts prewarm failed for ${url}: ${error instanceof Error ? error.message : 'unknown error'}. Jobs try again when they need it.`;
    }
  }));
  for (const warning of outcomes) if (warning) warnings.push(warning);
  return warnings;
}
