// Google Fonts proxy for trusted server code: bounded upstream fetch, append-only content-addressed
// cache, short-lived negative cache for upstream 4xx, daily budget, and per-revision font locks.
// This is the only code allowed to reach Google (AGENTS.md). Widget code never calls it directly.
import {createHash, createHmac, randomBytes, timingSafeEqual} from 'node:crypto';
import {parse as parseHtml} from 'parse5';
import postcss from 'postcss';
import type {ObjectStore, PreparedSnapshot, WidgetSnapshot} from './model';
import type {JsonObject} from '../src/types';
import {substitutePlaceholders} from '../src/config/placeholders';
import {previewState} from './preview';
import {ConflictError} from './errors';
import {BlobStore, ImmutableReadCache, LocalStore, mutateJson, readJson, writeJson} from './storage';
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
  /** Requests per client address to the public font file route, in this instance only (FONT_FILE_RATE_LIMIT). */
  readonly fileRequests = new Map<string, {start: number; count: number}>();
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

// ---------------------------------------------------------------------------------------------
// Job packages (stage 5): the fonts a render or test Sandbox receives as files. The Sandbox stays
// `deny-all`; the trusted worker answers Chromium from these files with `route.fulfill`.

/** A job package: lock entries (URL to status and SHA-256) and the objects they pin. */
export interface JobFontPackage {
  lock: {version: 1; epoch: string; userAgent: string; entries: FontLockEntry[]};
  objects: Map<string, Uint8Array>;
  bytes: number;
}
export const FONT_PACKAGE_MAX_ENTRIES = 1024;
export const FONT_PACKAGE_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Builds a job's font package from storage only; it never contacts Google. It holds the revision's
 * whole lock (4xx entries included), then the files each locked stylesheet lists that the cache
 * already holds, then `cachedUrls` (static stylesheets, the previous revision's lock) when the cache
 * already holds them in this revision's epoch and User-Agent. Anything else is found by a discovery pass.
 */
export async function buildJobFontPackage(options: {
  store: ObjectStore; projectId: string; revisionId: string; epoch: string; userAgent: string;
  cachedUrls?: readonly string[]; memory?: FontMemory;
}): Promise<JobFontPackage> {
  const ctx: Context = {
    store: options.store, bucket: 'render', epoch: options.epoch, userAgent: options.userAgent, sampleText: '', deadline: 0, now: Date.now,
    limits: {...FONT_BUDGET_LIMITS}, memory: options.memory ?? sharedMemory, lookup: undefined, transport: undefined
  };
  const entries = new Map<string, FontLockEntry>();
  const objects = new Map<string, Uint8Array>();
  let bytes = 0;
  const add = async (entry: FontLockEntry): Promise<void> => {
    if (entries.has(entry.url) || entries.size >= FONT_PACKAGE_MAX_ENTRIES) return;
    if (entry.status !== 200) { entries.set(entry.url, entry); return; }
    const body = objects.get(entry.sha256!) ?? await readObject(ctx, entry.sha256!, entry.bytes);
    // A missing or altered object is left out; the pass that needs it reports it missing.
    if (!body) return;
    if (!objects.has(entry.sha256!)) {
      if (bytes + body.byteLength > FONT_PACKAGE_MAX_BYTES) return;
      objects.set(entry.sha256!, body);
      bytes += body.byteLength;
    }
    entries.set(entry.url, entry);
  };
  const addCached = async (input: string): Promise<void> => {
    const canonical = canonicalGoogleFontsUrl(input);
    if (!canonical.ok || entries.has(canonical.url)) return;
    const indexed = await readIndex(ctx, canonical.url);
    if (indexed) await add({url: indexed.url, status: 200, sha256: indexed.sha256, bytes: indexed.bytes, contentType: indexed.contentType});
  };
  const locked = await lockForRevision(options.store, options.projectId, options.revisionId);
  for (const entry of locked) await add(entry);
  const stylesheetFiles = async (): Promise<void> => {
    for (const entry of [...entries.values()]) {
      if (entry.status !== 200 || entry.contentType !== 'text/css') continue;
      const body = objects.get(entry.sha256!);
      const validation = body ? validateGoogleCss(body) : undefined;
      if (validation?.ok) for (const file of validation.files) await addCached(file.url);
    }
  };
  await stylesheetFiles();
  for (const url of options.cachedUrls ?? []) await addCached(url);
  await stylesheetFiles();
  const sorted = [...entries.values()].sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  return {lock: {version: 1, epoch: options.epoch, userAgent: options.userAgent, entries: sorted}, objects, bytes};
}

/** At most this many URLs a pass reports missing are resolved; the list comes from an unsandboxed Chromium. */
export const FONT_REFILL_MAX_URLS = 256;

/** Re-canonicalizes and caps a worker's `needsFonts`: unique canonical Google Fonts URLs only. */
export function canonicalNeedsFonts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const urls: string[] = [];
  for (const item of value.slice(0, FONT_REFILL_MAX_URLS)) {
    if (typeof item !== 'string') continue;
    const canonical = canonicalGoogleFontsUrl(item);
    if (canonical.ok && !urls.includes(canonical.url)) urls.push(canonical.url);
  }
  return urls;
}

/**
 * Resolves the URLs a discovery pass missed, in the `render` budget bucket, into the cache and the
 * revision's lock (4xx answers included). Returns the failures that leave a font unavailable.
 */
export async function resolveMissingFonts(urls: readonly string[], options: {
  store: ObjectStore; projectId: string; revisionId: string; epoch: string; userAgent: string; deadline: number;
} & Pick<ResolveGoogleFontOptions, 'memory' | 'lookup' | 'transport' | 'now' | 'budgetLimits'>): Promise<{url: string; reason: FontUnavailableReason; message: string}[]> {
  const {store, projectId, revisionId, ...rest} = options;
  const failures: {url: string; reason: FontUnavailableReason; message: string}[] = [];
  const queue = [...urls];
  const worker = async () => {
    for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
      const result = await resolveGoogleFont(url, {...rest, store, bucket: 'render', lock: {projectId, revisionId}});
      if (result.status === 'unavailable') failures.push({url, reason: result.reason, message: result.message});
    }
  };
  await Promise.all(Array.from({length: Math.min(EAGER_CONCURRENCY, queue.length)}, worker));
  return failures.sort((a, b) => (a.url < b.url ? -1 : 1));
}

// ---------------------------------------------------------------------------------------------
// Editor preview (stage 6): Google stylesheets become CSS whose font files point at the public,
// cache-only route `/api/fonts/v1/f/<sha256>.<mac>.<ext>`. The route never contacts Google.

export const FONT_FILE_ROUTE = '/api/fonts/v1/f/';
export type FontFileExtension = 'woff2' | 'woff' | 'ttf' | 'otf';
const FONT_FILE_EXTENSIONS: Readonly<Record<string, FontFileExtension>> = {'font/woff2': 'woff2', 'font/woff': 'woff', 'font/ttf': 'ttf', 'font/otf': 'otf'};
const FONT_FILE_TYPES: Readonly<Record<FontFileExtension, string>> = {woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf'};
const FONT_FILE_NAME = /^([0-9a-f]{64})\.([0-9a-f]{16})\.(woff2|woff|ttf|otf)$/;
/**
 * Key of the URL filter. The suffix is a filter, not a capability: it keeps random SHA-256 guesses
 * from costing a Blob read on a public route. Created once per store, never overwritten.
 */
const FONT_URL_KEY = 'fonts/v1/url-key.json';
const urlKeys = new Map<string, Promise<Buffer>>();
const urlKeysByStore = new WeakMap<ObjectStore, Promise<Buffer>>();

/** Every request gets a new BlobStore, so the key is cached per backing store, not per object. */
function storeIdentity(store: ObjectStore): string | undefined {
  if (store instanceof BlobStore) return 'blob';
  if (store instanceof LocalStore) return `local:${store.root}`;
  return undefined;
}

async function loadUrlKey(store: ObjectStore): Promise<Buffer> {
  const read = async () => {
    const value = await readJson<{version: number; key: string}>(store, FONT_URL_KEY);
    return value && typeof value.key === 'string' && /^[0-9a-f]{64}$/.test(value.key) ? Buffer.from(value.key, 'hex') : undefined;
  };
  const existing = await read();
  if (existing) return existing;
  try { await writeJson(store, FONT_URL_KEY, {version: 1, key: randomBytes(32).toString('hex')}); }
  catch (error) { if (!(error instanceof ConflictError)) throw error; } // Another instance created it first.
  const created = await read();
  if (!created) throw new Error('The Google Fonts URL key is missing or corrupt.');
  return created;
}

export function fontUrlKey(store: ObjectStore): Promise<Buffer> {
  const identity = storeIdentity(store);
  const cached = identity ? urlKeys.get(identity) : urlKeysByStore.get(store);
  if (cached) return cached;
  const loading = loadUrlKey(store);
  if (identity) urlKeys.set(identity, loading); else urlKeysByStore.set(store, loading);
  loading.catch(() => { if (identity) urlKeys.delete(identity); else urlKeysByStore.delete(store); });
  return loading;
}

const fontFileMac = (key: Buffer, digest: string, extension: FontFileExtension): string =>
  createHmac('sha256', key).update(`${FONT_CACHE_EPOCH}|${digest}.${extension}`).digest('hex').slice(0, 16);

/** The public, cache-only URL of a cached font object, or undefined for a type the route does not serve. */
export async function publicFontUrl(store: ObjectStore, origin: string, digest: string, contentType: string): Promise<string | undefined> {
  const extension = FONT_FILE_EXTENSIONS[contentType];
  if (!extension || !isSha256(digest)) return undefined;
  return `${new URL(origin).origin}${FONT_FILE_ROUTE}${digest}.${fontFileMac(await fontUrlKey(store), digest, extension)}.${extension}`;
}

const FONT_FILE_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'",
  'Referrer-Policy': 'no-referrer'
};
const fontFileRefusal = (status: number, cacheSeconds: number, extra: Record<string, string> = {}): Response => new Response(null, {
  status,
  headers: {...FONT_FILE_HEADERS, 'Cache-Control': cacheSeconds ? `public, max-age=${cacheSeconds}` : 'no-store', ...(cacheSeconds ? {'CDN-Cache-Control': `public, max-age=${cacheSeconds}`} : {}), ...(status === 405 ? {Allow: 'GET, HEAD'} : {}), ...extra}
});

/**
 * Requests one client address may make to the public font file route per window. The count lives in
 * this instance's memory: a deployment runs several function instances, each with its own count, and a
 * cold start begins at zero, so this limits each instance, not the deployment (the deployment-wide limit
 * is the Vercel firewall rule in docs/VERCEL.md). CDN hits never reach the function. Hosted jobs never
 * call the route (their fonts arrive as job files the trusted worker serves), so only editor previews
 * count, and one preview of CJK text asks for dozens of subset files at once: hence a high ceiling.
 */
export const FONT_FILE_RATE_LIMIT = {requests: 600, windowMs: 60_000, clients: 10_000};

/** The client address Vercel's edge sets (it overwrites x-real-ip and x-forwarded-for); requests without one share a bucket. */
export function clientAddress(request: Request): string {
  const header = request.headers.get('x-real-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0] ?? '';
  const address = header.trim().toLowerCase();
  return /^[0-9a-f.:]{2,45}$/.test(address) ? address : 'unknown';
}

/** Counts one request from `client` in a fixed window: 0 when allowed, otherwise the seconds until the window ends. */
export function takeFontFileRequest(memory: FontMemory, client: string, now: number): number {
  const {requests, windowMs, clients} = FONT_FILE_RATE_LIMIT;
  const windows = memory.fileRequests;
  let window = windows.get(client);
  if (!window || now - window.start >= windowMs) {
    windows.delete(client);
    if (windows.size >= clients) {
      for (const [key, value] of windows) if (now - value.start >= windowMs) windows.delete(key);
      if (windows.size >= clients) windows.delete(windows.keys().next().value!);
    }
    window = {start: now, count: 0};
    windows.set(client, window);
  }
  if (window.count >= requests) return Math.max(1, Math.ceil((window.start + windowMs - now) / 1000));
  window.count++;
  return 0;
}

/**
 * `GET /api/fonts/v1/f/<sha256>.<mac>.<ext>`: bytes already in the Google Fonts cache, immutable.
 * Public on purpose: fonts requested by the opaque preview iframe arrive with `Origin: null` and no
 * credentials. It never contacts Google and never spends budget. The MAC is checked before any
 * storage read, and the bytes are hashed and sniffed on every read. Each client address is limited per
 * instance (FONT_FILE_RATE_LIMIT) with an uncached 429 and Retry-After, before anything else runs.
 */
export async function fontFileResponse(request: Request, file: string, store: () => ObjectStore, memory: FontMemory = sharedMemory, now: () => number = Date.now): Promise<Response> {
  const retryAfter = takeFontFileRequest(memory, clientAddress(request), now());
  if (retryAfter) return fontFileRefusal(429, 0, {'Retry-After': String(retryAfter)});
  if (request.method !== 'GET' && request.method !== 'HEAD') return fontFileRefusal(405, 0);
  const url = new URL(request.url);
  if (url.search !== '' || request.url.includes('?')) return fontFileRefusal(400, 0);
  const match = FONT_FILE_NAME.exec(file);
  if (!match) return fontFileRefusal(404, 60);
  const [, digest, mac, extension] = match as unknown as [string, string, string, FontFileExtension];
  let objects: ObjectStore;
  try { objects = store(); } catch { return fontFileRefusal(503, 0); }
  try {
    const expected = Buffer.from(fontFileMac(await fontUrlKey(objects), digest, extension), 'hex');
    if (!timingSafeEqual(expected, Buffer.from(mac, 'hex'))) return fontFileRefusal(404, 60);
    const body = await memory.reads.read(objects, fontObjectKey(digest));
    if (!body || sha256(body) !== digest) return fontFileRefusal(404, 60);
    const format = sniffFont(body);
    if (format !== extension) return fontFileRefusal(404, 60);
    const immutable = 'public, max-age=31536000, immutable';
    return new Response(request.method === 'HEAD' ? null : Buffer.from(body), {
      status: 200,
      headers: {...FONT_FILE_HEADERS, 'Content-Type': FONT_FILE_TYPES[extension], 'Content-Length': String(body.byteLength), 'Cache-Control': immutable, 'CDN-Cache-Control': immutable}
    });
  } catch {
    return fontFileRefusal(503, 0);
  }
}

/** What the preview gets for one Google Fonts URL. */
export type PreviewFontResult =
  | {status: 'ok'; kind: 'css'; url: string; css: string; partial: boolean}
  | {status: 'ok'; kind: 'font'; url: string; href: string}
  | {status: 'upstream-4xx'; url: string; httpStatus: number; message: string}
  | {status: 'unavailable'; code: 'FONT_UNAVAILABLE' | 'FONT_UNSUPPORTED'; url: string; reason: FontUnavailableReason; message: string};

export interface PreviewFontOptions extends Pick<ResolveGoogleFontOptions, 'memory' | 'lookup' | 'transport' | 'now' | 'budgetLimits' | 'lock'> {
  store: ObjectStore;
  /** The Studio origin the public font route is served from. */
  origin: string;
  epoch: string;
  userAgent: string;
  sampleText?: string;
  /** Absolute epoch milliseconds for every upstream request. */
  deadline: number;
}

/**
 * Resolves a Google Fonts URL for the editor preview, in the `preview` budget bucket. A stylesheet
 * comes back with every `url()` pointing at the public cache-only route; the files that cover the
 * sample text (plus Basic Latin) are fetched when the cache lacks them, and `@font-face` rules whose
 * files are still not cached are removed and the result is marked `partial`. A font file URL comes
 * back as its public route URL. Only the stylesheet itself goes into the lock, when one is given:
 * files are pinned by the write-once index, as in job packages.
 */
export async function cssForPreview(input: string, options: PreviewFontOptions): Promise<PreviewFontResult> {
  const {store, origin, epoch, userAgent, sampleText = '', deadline, lock, ...inject} = options;
  const base = {...inject, store, bucket: 'preview' as const, epoch, userAgent, sampleText, deadline};
  const resolved = await resolveGoogleFont(input, {...base, ...(lock ? {lock} : {})});
  if (resolved.status === 'upstream-4xx') return {status: 'upstream-4xx', url: resolved.url, httpStatus: resolved.httpStatus, message: resolved.message};
  if (resolved.status === 'unavailable') return resolved;
  if (resolved.kind === 'font') {
    const href = await publicFontUrl(store, origin, resolved.sha256, resolved.contentType);
    return href ? {status: 'ok', kind: 'font', url: resolved.url, href} : unavailable(resolved.url, 'unsupported', `The preview cannot serve ${resolved.contentType} font files.`) as PreviewFontResult;
  }
  const text = Buffer.from(resolved.body).toString('utf8');
  const validation = validateGoogleCss(text);
  if (!validation.ok) return unavailable(resolved.url, 'invalid', validation.message) as PreviewFontResult;
  const points = samplePoints(sampleText);
  const ctx: Context = {
    store, bucket: 'preview', epoch, userAgent, sampleText, deadline, now: inject.now ?? Date.now,
    limits: {...FONT_BUDGET_LIMITS, ...inject.budgetLimits}, memory: inject.memory ?? sharedMemory, lookup: inject.lookup, transport: inject.transport
  };
  const hrefs = new Map<string, string>();
  const listed = unique(validation.files.map(file => file.url));
  const covering = unique(validation.files.filter(file => coversAny(file.unicodeRange, points)).map(file => file.url));
  // A short list is looked up whole, so cached subsets are kept; a long one (CJK) only where it covers the sample.
  const lookedUp = listed.length <= FONT_EAGER_MAX_FILES ? listed : covering;
  const inParallel = async (urls: readonly string[], run: (url: string) => Promise<void>) => {
    const queue = [...urls];
    await Promise.all(Array.from({length: Math.min(8, queue.length)}, async () => { for (let url = queue.shift(); url !== undefined; url = queue.shift()) await run(url); }));
  };
  // The index is write-once and the public route hashes the bytes it serves, so the entry is enough here.
  await inParallel(lookedUp, async url => {
    const entry = await readIndex(ctx, url);
    const href = entry ? await publicFontUrl(store, origin, entry.sha256, entry.contentType) : undefined;
    if (href) hrefs.set(url, href);
  });
  await inParallel(covering.filter(url => !hrefs.has(url)), async url => {
    if (Date.now() >= deadline) return;
    const file = await resolveGoogleFont(url, base);
    const href = file.status === 'ok' ? await publicFontUrl(store, origin, file.sha256, file.contentType) : undefined;
    if (href) hrefs.set(url, href);
  });
  if (validation.files.length && hrefs.size === 0) return unavailable(resolved.url, 'upstream', `None of the font files ${resolved.url} lists could be cached yet.`) as PreviewFontResult;
  let partial = false;
  const tree = postcss.parse(text);
  tree.walkAtRules(rule => {
    if (rule.name.toLowerCase() !== 'font-face') return;
    let complete = true;
    rule.walkDecls(declaration => {
      if (declaration.prop.toLowerCase() !== 'src') return;
      declaration.value = declaration.value.replace(/url\(\s*(['"]?)([^'"()\s\\]+)\1\s*\)/gi, (whole, _quote: string, raw: string) => {
        const canonical = canonicalGoogleFontsUrl(raw);
        const href = canonical.ok ? hrefs.get(canonical.url) : undefined;
        if (!href) { complete = false; return whole; }
        return `url(${JSON.stringify(href)})`;
      });
    });
    if (!complete) { rule.remove(); partial = true; }
  });
  return {status: 'ok', kind: 'css', url: resolved.url, css: tree.toString(), partial};
}

/** The body of `POST /api/studio/projects/:id/fonts` and of `host:font-response`. */
export type PreviewFontAnswer =
  | {status: 'ok'; css: string; partial: boolean}
  | {status: 'upstream-4xx'; httpStatus: number; message: string}
  | {status: 'unavailable'; code: 'FONT_UNAVAILABLE' | 'FONT_UNSUPPORTED'; reason: FontUnavailableReason; message: string};

/** The preview broker's answer for a stylesheet URL. Font file URLs are refused: a `<link>` never loads one. */
export async function previewFontAnswer(url: string, options: PreviewFontOptions): Promise<PreviewFontAnswer> {
  const canonical = canonicalGoogleFontsUrl(url);
  if (canonical.ok && canonical.kind !== 'css') return {status: 'unavailable', code: 'FONT_UNSUPPORTED', reason: 'unsupported', message: `Only Google Fonts stylesheets load through a <link>, not ${canonical.url}.`};
  const result = await cssForPreview(url, options);
  if (result.status === 'ok') return result.kind === 'css' ? {status: 'ok', css: result.css, partial: result.partial} : {status: 'unavailable', code: 'FONT_UNSUPPORTED', reason: 'unsupported', message: 'Only Google Fonts stylesheets load through a <link>.'};
  if (result.status === 'upstream-4xx') return {status: 'upstream-4xx', httpStatus: result.httpStatus, message: result.message};
  return {status: 'unavailable', code: result.code, reason: result.reason, message: result.message};
}

/** Requests per project per minute on one instance: the preview broker can be driven by widget code. */
export const PREVIEW_FONT_RATE_LIMIT = {requests: 120, windowMs: 60_000};
const previewFontRequests = new Map<string, number[]>();
/** False when the project has used its per-minute preview font requests on this instance. */
export function takePreviewFontRequest(projectId: string, now = Date.now()): boolean {
  const recent = (previewFontRequests.get(projectId) ?? []).filter(time => now - time < PREVIEW_FONT_RATE_LIMIT.windowMs);
  if (recent.length >= PREVIEW_FONT_RATE_LIMIT.requests) { previewFontRequests.set(projectId, recent); return false; }
  recent.push(now);
  previewFontRequests.set(projectId, recent);
  if (previewFontRequests.size > 1000) for (const key of previewFontRequests.keys()) { if (key !== projectId) { previewFontRequests.delete(key); break; } }
  return true;
}
