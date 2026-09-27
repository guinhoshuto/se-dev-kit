// Replays a job's Google Fonts package in the trusted worker (fonts plan, stage 5). The package is a
// lock file (`lock-<pass>.json`, URL to status and SHA-256) plus `objects/<sha256>` files that the
// workflow uploaded with the job. The resolver never uses the network: a URL outside the lock is a
// miss, recorded so the workflow can fetch it through the proxy and run a further pass.
import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {StudioError} from "../shared/errors.js";
import {FONT_CACHE_EPOCH, GOOGLE_FONTS_UA, canonicalGoogleFontsUrl} from "../runtime/google-fonts-url.js";
import type {FontRoute, FontRouteAnswer} from "../capture/browser.js";

/** One URL of the package: `200` with the pinned object, or the upstream 4xx Google answered. */
export interface FontLockEntry {
  url: string;
  status: number;
  sha256?: string;
  bytes?: number;
  contentType?: string;
}

export interface FontLockFile {
  version: 1;
  epoch: string;
  userAgent: string;
  entries: FontLockEntry[];
}

/** What a render or test served, as `manifest.fonts.served` records it. */
export interface ServedFont {
  url: string;
  status: number;
  sha256?: string;
  bytes?: number;
}

/** The `fonts` section of a hosted manifest or test report. */
export interface FontServingReport {
  mode: "cache";
  epoch: string;
  userAgent: string;
  servedDigest: string;
  served: ServedFont[];
}

/** Canonical URLs a discovery pass asked for that were not in the package. At most this many go back. */
export const FONTS_MISSING_MAX_URLS = 256;

/** A discovery pass found Google Fonts URLs outside the package. Internal: it triggers a refill, never a user error. */
export class FontsMissingError extends StudioError {
  readonly urls: string[];
  constructor(urls: readonly string[]) {
    const list = [...new Set(urls)].sort().slice(0, FONTS_MISSING_MAX_URLS);
    super("FONTS_MISSING", `Google Fonts outside the job package: ${list.join(", ")}.`);
    this.urls = list;
  }
}

export function isFontsMissing(error: unknown): error is StudioError & {urls: string[]} {
  return error instanceof StudioError && error.code === "FONTS_MISSING" && Array.isArray((error as {urls?: unknown}).urls);
}

const isSha256 = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const sha256 = (body: Uint8Array | string): string => createHash("sha256").update(body).digest("hex");

function validEntry(value: unknown): value is FontLockEntry {
  const entry = value as FontLockEntry | null;
  if (typeof entry !== "object" || entry === null || typeof entry.url !== "string" || !Number.isInteger(entry.status)) return false;
  if (entry.status === 200) {
    return isSha256(entry.sha256) && Number.isSafeInteger(entry.bytes) && typeof entry.contentType === "string";
  }
  return entry.status >= 400 && entry.status < 500;
}

/** Parses a lock file, keeping only valid entries whose URL is already canonical. */
export function parseFontLock(value: unknown): FontLockFile {
  const raw = value as Partial<FontLockFile> | null;
  if (typeof raw !== "object" || raw === null || raw.version !== 1 || !Array.isArray(raw.entries)) {
    throw new StudioError("FONT_LOCK_INVALID", "The job's Google Fonts lock file is not valid.");
  }
  const entries = raw.entries.filter((entry): entry is FontLockEntry => {
    if (!validEntry(entry)) return false;
    const canonical = canonicalGoogleFontsUrl(entry.url);
    return canonical.ok && canonical.url === entry.url;
  });
  return {
    version: 1,
    epoch: typeof raw.epoch === "string" ? raw.epoch : FONT_CACHE_EPOCH,
    userAgent: typeof raw.userAgent === "string" ? raw.userAgent : GOOGLE_FONTS_UA,
    entries
  };
}

/** Order-independent digest of what was served: URL, status and SHA-256 of each entry (same as `servedDigest` in lib/fonts). */
export function servedFontsDigest(entries: readonly ServedFont[]): string {
  return sha256(entries.map((entry) => JSON.stringify([entry.url, entry.status, entry.sha256 ?? null])).sort().join("\n"));
}

/** Short body for a replayed 4xx, like Google's error page. */
const REFUSAL_BODY = Buffer.from("<!doctype html><title>Google Fonts refused this request</title>");

type Memo = FontRouteAnswer | "missing";

export class FontResolver {
  readonly epoch: string;
  readonly userAgent: string;
  readonly #entries = new Map<string, FontLockEntry>();
  readonly #readObject: (digest: string) => Promise<Uint8Array | undefined>;
  // Playwright disables the HTTP cache while routes are active, so every context would re-read the
  // package; answers are kept in memory once read, and handed out synchronously after that.
  readonly #memo = new Map<string, Memo>();
  readonly #pending = new Map<string, Promise<Memo>>();
  readonly #served = new Map<string, ServedFont>();
  readonly #missing = new Set<string>();

  constructor(lock: FontLockFile, readObject: (digest: string) => Promise<Uint8Array | undefined>) {
    this.epoch = lock.epoch;
    this.userAgent = lock.userAgent;
    for (const entry of lock.entries) this.#entries.set(entry.url, entry);
    this.#readObject = readObject;
  }

  /** Loads `lock-<pass>.json` and `objects/` from a job's fonts directory. A missing lock is an empty package. */
  static async load(directory: string, pass: number): Promise<FontResolver> {
    if (!Number.isSafeInteger(pass) || pass < 1) throw new StudioError("FONT_LOCK_INVALID", `Invalid font pass: ${pass}.`);
    let lock: FontLockFile = {version: 1, epoch: FONT_CACHE_EPOCH, userAgent: GOOGLE_FONTS_UA, entries: []};
    try {
      lock = parseFontLock(JSON.parse(await readFile(resolve(directory, `lock-${pass}.json`), "utf8")));
    } catch (error) {
      if ((error as {code?: unknown}).code !== "ENOENT") throw error;
    }
    return new FontResolver(lock, async (digest) => {
      try {
        return await readFile(resolve(directory, "objects", digest));
      } catch (error) {
        if ((error as {code?: unknown}).code === "ENOENT") return undefined;
        throw error;
      }
    });
  }

  /** The route answer for a Google Fonts URL, or `undefined` for a miss (recorded) or a URL that cannot be canonicalized. */
  readonly route: FontRoute = async (url) => {
    const canonical = canonicalGoogleFontsUrl(url);
    if (!canonical.ok) return undefined;
    const known = this.#memo.get(canonical.url) ?? (await this.#lookup(canonical.url));
    if (known === "missing") {
      this.#missing.add(canonical.url);
      return undefined;
    }
    return known;
  };

  async #lookup(url: string): Promise<Memo> {
    let pending = this.#pending.get(url);
    if (!pending) {
      pending = this.#answer(url).then((answer) => {
        this.#memo.set(url, answer);
        this.#pending.delete(url);
        return answer;
      });
      this.#pending.set(url, pending);
    }
    return pending;
  }

  async #answer(url: string): Promise<Memo> {
    const entry = this.#entries.get(url);
    if (!entry) return "missing";
    if (entry.status !== 200) {
      this.#served.set(url, {url, status: entry.status});
      return {status: entry.status, contentType: "text/html; charset=utf-8", body: REFUSAL_BODY};
    }
    const body = await this.#readObject(entry.sha256!);
    // The object is checked on every first read; a missing or altered object is a miss, never served.
    if (!body || body.byteLength !== entry.bytes || sha256(body) !== entry.sha256) return "missing";
    this.#served.set(url, {url, status: 200, sha256: entry.sha256!, bytes: entry.bytes!});
    return {status: 200, contentType: entry.contentType!, body: Buffer.from(body)};
  }

  /** True once any requested URL was outside the package. */
  hasMissing(): boolean {
    return this.#missing.size > 0;
  }

  /** Whether this URL (any spelling Google Fonts accepts) was a miss. */
  isMissing(url: string): boolean {
    const canonical = canonicalGoogleFontsUrl(url);
    return canonical.ok && this.#missing.has(canonical.url);
  }

  /** Canonical missing URLs, sorted. */
  missing(): string[] {
    return [...this.#missing].sort();
  }

  served(): ServedFont[] {
    return [...this.#served.values()].sort((left, right) => (left.url < right.url ? -1 : left.url > right.url ? 1 : 0));
  }

  report(): FontServingReport {
    const served = this.served();
    return {mode: "cache", epoch: this.epoch, userAgent: this.userAgent, servedDigest: servedFontsDigest(served), served};
  }
}
