import {execFile} from "node:child_process";
import {access, lstat, realpath, rm} from "node:fs/promises";
import {constants} from "node:fs";
import {cpus, loadavg, platform, tmpdir} from "node:os";
import {basename, dirname, resolve} from "node:path";
import {promisify} from "node:util";
import {chromium, errors, type Browser, type BrowserContext, type Page, type Request} from "playwright-core";
import {StudioError} from "../shared/errors.js";
import {canonicalGoogleFontsUrl, isGoogleFontsHost} from "../runtime/google-fonts-url.js";

export interface BrowserDetection {
  executablePath?: string;
  source?: "explicit" | "environment" | "playwright-cache" | "system";
  checked: string[];
}

const SYSTEM_PATHS: Record<string, string[]> = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge"
  ],
  win32: []
};

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function detectBrowser(explicitPath?: string): Promise<BrowserDetection> {
  const checked: string[] = [];
  const candidates: {path: string; source: NonNullable<BrowserDetection["source"]>}[] = [];
  if (explicitPath) {
    checked.push(explicitPath);
    return (await executable(explicitPath))
      ? {executablePath: await realpath(explicitPath), source: "explicit", checked}
      : {checked};
  }
  const environmentPath = process.env.SE_WIDGET_STUDIO_BROWSER;
  if (environmentPath) candidates.push({path: environmentPath, source: "environment"});
  // The system Chrome first: Playwright's Chromium build has no proprietary codecs, so H.264/AAC
  // media (a widget's .mp4 video) fails to load in it, and so does the capture. The cache is only a fallback.
  for (const path of SYSTEM_PATHS[platform()] ?? []) candidates.push({path, source: "system"});
  const cached = chromium.executablePath();
  if (cached) candidates.push({path: cached, source: "playwright-cache"});

  for (const candidate of candidates) {
    checked.push(candidate.path);
    if (await executable(candidate.path)) {
      return {executablePath: await realpath(candidate.path), source: candidate.source, checked};
    }
  }
  return {checked};
}

/**
 * An inert Chrome switch on every browser this module starts, valued `<pid>-<launch>`. `npm run
 * kill-stale` finds this checkout's orphans by it without touching another session's Chrome, and a
 * close that hangs finds the process to kill by it.
 */
export const BROWSER_MARKER = "--se-widget-studio";
let launches = 0;
/** What a close that runs out of time needs of a browser launchStudioBrowser started. */
interface LaunchRecord {
  marker: string;
  /** os.tmpdir() as it was at the launch: Playwright made the browser's folders in it. */
  temporary: string;
  /** The browser's artifacts folder and profile, from Playwright's own server object; empty when it moved. */
  folders: string[];
}
const launched = new WeakMap<Browser, LaunchRecord>();

/** How long Chrome may take to start before the launch fails and the process it started is killed. */
export const LAUNCH_TIMEOUT_MS = 30_000;
/** How long `browser.close()` may take before the browser's process group is killed. */
export const CLOSE_TIMEOUT_MS = 10_000;
// Room for Playwright to report its own launch timeout first. It may not: on its timeout it waits for
// the process to close gracefully, which a hung browser never does (a fake one held it for 30 s).
const LAUNCH_GRACE_MS = 5_000;
/**
 * How long a close or a launch that ran out of time waits, after its browser was killed, for Playwright's own cleanup
 * to finish before this module removes that browser's folders itself (#52). Playwright removes them only after the
 * process and every helper holding its stderr are gone, and asynchronously: under load, or with a helper that
 * outlives the kill, a render's process could exit first and leave them in TMPDIR.
 */
export const CLEANUP_TIMEOUT_MS = 5_000;
/** The prefixes of the folders Playwright 1.54 makes in os.tmpdir() for a launch (server/browserType.js). */
const PLAYWRIGHT_FOLDER = /^(?:playwright-artifacts-|playwright_chromiumdev_profile-)[^/]+$/;
const OUTER_DEADLINE = Symbol("launch deadline");

const execFileAsync = promisify(execFile);

/**
 * Chrome switches on every browser this module starts so that two renders of the same frames give
 * the same pixels. With the GPU, Chrome's raster varies by one level on edges and text from run to
 * run (35 to 124 of tutorial-setup's 945 frame hashes differed on an idle machine); its software
 * raster is reproducible, at about 22% more capture time (SDK-39).
 *
 * Without threaded animation, a transition runs only on the main thread, where the frame sampler pauses it. On the
 * compositor, a real Chrome frame that falls between the class change and the pause starts it, the compositor draws
 * its next tick, and that value stays on screen until the page next changes it, past the pause and a second
 * screenshot: under load a frame at the change instant read 16 ms into the fade while the page said `opacity: 1` (#33).
 */
export const REPRODUCIBLE_RASTER_ARGS: readonly string[] = ["--disable-gpu", "--disable-threaded-animation"];

/**
 * How many times a launch that ran out of time starts again (#33). A launch takes about 0.3 s and 20 s at worst in the
 * kept test logs, so 30 s means an overloaded machine, and a render holding the slot has no other render of this
 * repository to wait for. One more start saves a passing overload, like the single timeout of a `npm test` on
 * 2026-11-04; one that outlasts it still fails, like the 7 timeouts in a row of 2026-10-27.
 */
export const LAUNCH_RETRIES = 1;
/** Starts the stderr line of a retried launch; scripts/run-tests.mjs counts it for a suite's summary. */
export const LAUNCH_RETRY_NOTE = "Chrome launch retried:";

export async function launchStudioBrowser(options: {
  browserPath?: string;
  headed?: boolean;
  launchTimeoutMs?: number;
  /** Starts after the first one when a launch runs out of time; LAUNCH_RETRIES by default. */
  launchRetries?: number;
  /** Takes the line that says a launch started again, and why; stderr by default. */
  onLaunchRetry?: (line: string) => void;
  /** How long a launch that ran out of time waits for Playwright's cleanup; CLEANUP_TIMEOUT_MS by default. */
  cleanupTimeoutMs?: number;
} = {}): Promise<{browser: Browser; detection: BrowserDetection}> {
  const detection = await detectBrowser(options.browserPath);
  const executablePath = detection.executablePath;
  if (!executablePath) {
    throw new StudioError(
      "BROWSER_NOT_FOUND",
      "No compatible Chromium or Chrome executable was found.",
      "Install a system Chrome/Chromium yourself, then pass --browser-path /absolute/path or set SE_WIDGET_STUDIO_BROWSER. The Studio never downloads browsers automatically."
    );
  }
  for (let retries = options.launchRetries ?? LAUNCH_RETRIES; ; retries -= 1) {
    try {
      return {browser: await launchOnce(executablePath, options), detection};
    } catch (error) {
      if (retries <= 0 || !(error instanceof StudioError) || error.code !== "BROWSER_LAUNCH_TIMEOUT") throw error;
      const line = `${LAUNCH_RETRY_NOTE} ${error.message} That process was killed and Chrome starts once more; load ${loadavg()[0]!.toFixed(1)} on ${cpus().length} cores.`;
      if (options.onLaunchRetry) options.onLaunchRetry(line);
      else process.stderr.write(`${line}\n`);
    }
  }
}

async function launchOnce(executablePath: string, options: {headed?: boolean; launchTimeoutMs?: number; cleanupTimeoutMs?: number}): Promise<Browser> {
  launches += 1;
  const marker = `${BROWSER_MARKER}=${process.pid}-${launches}`;
  const timeout = options.launchTimeoutMs ?? LAUNCH_TIMEOUT_MS;
  const launchTimeout = (cleanup: BrowserCleanup) => new StudioError(
    "BROWSER_LAUNCH_TIMEOUT",
    `Chrome did not start within ${timeout / 1000} s (${executablePath}).`,
    `The machine may be busy with another render: check for running headless Chrome, wait, and retry. The process this launch started was killed; ${describeCleanup("launch", cleanup)}.`
  );
  const temporary = tmpdir();
  const launching = chromium.launch({executablePath, headless: !options.headed, args: [marker, ...REPRODUCIBLE_RASTER_ARGS], timeout});
  let deadline: NodeJS.Timeout | undefined;
  try {
    const browser = await Promise.race([
      launching,
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(OUTER_DEADLINE), timeout + LAUNCH_GRACE_MS);
      })
    ]);
    launched.set(browser, {marker, temporary, folders: playwrightFolders(browser)});
    return browser;
  } catch (error) {
    // A launch that settles after the deadline must not leave its browser running.
    launching.then((late) => late.close()).catch(() => undefined);
    if (error !== OUTER_DEADLINE && !(error instanceof errors.TimeoutError)) throw error;
    const killed = await killLaunchedBrowser(marker);
    // The profile this launch made, named by the killed process's command line or, when Playwright's own timeout came
    // first and its process is gone, by the call log of that error. The artifacts folder is named by neither.
    const profiles = new Set([...killed.map((child) => child.command), error instanceof Error ? error.message : ""].flatMap(userDataDirs));
    const started = Date.now();
    const settled = await settlesWithin(launching, options.cleanupTimeoutMs ?? CLEANUP_TIMEOUT_MS);
    throw launchTimeout({settled, waitedMs: Date.now() - started, ...await removeLaunchFolders([...profiles], temporary)});
  } finally {
    clearTimeout(deadline);
  }
}

/** The `--user-data-dir` values in a command line or a Playwright call log. A path with a space ends at it. */
function userDataDirs(text: string): string[] {
  return [...text.matchAll(/(?:^|\s)--user-data-dir=(\S+)/g)].map((match) => match[1]!);
}

/** Whether `promise` settles, either way, within `ms`. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const settled = await Promise.race([
    promise.then(() => true, () => true),
    new Promise<false>((resolveWait) => {
      timer = setTimeout(() => resolveWait(false), ms);
    })
  ]);
  clearTimeout(timer);
  return settled;
}

/**
 * The artifacts folder and the profile of a launched browser, read from Playwright's server object behind the
 * in-process client (`_toImpl`, `options.artifactsDir`, `_userDataDirForTest` in playwright-core 1.54). Internal:
 * tests/unit/browser-lifecycle.test.mjs pins it, so an upgrade that moves them fails there instead of cleaning nothing.
 */
function playwrightFolders(browser: Browser): string[] {
  try {
    const server = (browser as unknown as {_toImpl?: () => unknown})._toImpl?.() as {options?: {artifactsDir?: unknown}; _userDataDirForTest?: unknown} | undefined;
    return [server?.options?.artifactsDir, server?._userDataDirForTest].filter((folder): folder is string => typeof folder === "string");
  } catch {
    return [];
  }
}

/** The folders closeStudioBrowser would remove for `browser` after a close that ran out of time. For tests. */
export function launchFolders(browser: Browser): {temporary: string; folders: string[]} | undefined {
  const record = launched.get(browser);
  return record && {temporary: record.temporary, folders: [...record.folders]};
}

/** The folders of one launch that were removed, already gone, could not be removed, or were not removed. */
export interface FolderCleanup {
  /** Folder names. */
  removed: string[];
  gone: string[];
  failed: string[];
  /** Full paths: not a Playwright folder directly in the launch's temporary folder, or not a plain directory. */
  skipped: string[];
}

export interface BrowserCleanup extends FolderCleanup {
  /** Whether Playwright's own close (or launch) settled while it was waited for, after the kill. */
  settled: boolean;
  waitedMs: number;
}

/**
 * Removes the folders that `folders` names, each only when it is a Playwright launch folder directly in `temporary`
 * (os.tmpdir() at its launch) and a plain directory: a path from anywhere else is skipped and reported, never removed.
 */
export async function removeLaunchFolders(folders: string[], temporary: string): Promise<FolderCleanup> {
  const result: FolderCleanup = {removed: [], gone: [], failed: [], skipped: []};
  for (const folder of new Set(folders)) {
    const name = basename(folder);
    if (dirname(resolve(folder)) !== resolve(temporary) || !PLAYWRIGHT_FOLDER.test(name)) {
      result.skipped.push(folder);
      continue;
    }
    let directory: boolean;
    try {
      // lstat: a symbolic link is no directory, so a link named like a profile is skipped, its target untouched.
      directory = (await lstat(folder)).isDirectory();
    } catch {
      result.gone.push(name);
      continue;
    }
    if (!directory) {
      result.skipped.push(folder);
      continue;
    }
    try {
      await rm(folder, {recursive: true, force: true, maxRetries: 5});
      result.removed.push(name);
    } catch {
      result.failed.push(name);
    }
  }
  return result;
}

/** One clause on what happened after a kill: `Playwright's close finished after 3120 ms; removed …`. */
export function describeCleanup(what: "close" | "launch", cleanup: BrowserCleanup): string {
  const parts = [`Playwright's ${what} ${cleanup.settled ? "finished" : "still pending"} after ${cleanup.waitedMs} ms`];
  if (cleanup.removed.length) parts.push(`removed ${cleanup.removed.join(", ")}`);
  if (cleanup.gone.length) parts.push(`already gone ${cleanup.gone.join(", ")}`);
  if (cleanup.failed.length) parts.push(`could not remove ${cleanup.failed.join(", ")}`);
  if (cleanup.skipped.length) parts.push(`skipped ${cleanup.skipped.join(", ")} (not a Playwright folder of the temporary folder)`);
  if (parts.length === 1) parts.push("no folder of it named");
  return parts.join("; ");
}

export interface BrowserCloseResult {
  /** False when the close ran out of time and the browser was killed instead. */
  closed: boolean;
  elapsedMs: number;
  killed: number[];
  /** After a close that ran out of time, for a browser from launchStudioBrowser: the wait and its folders. */
  cleanup?: BrowserCleanup;
}

/**
 * Closes a browser from launchStudioBrowser within `timeoutMs`. A close that hangs kills the
 * browser's process group (found by its marker among this process's children), so a finished
 * render never waits forever on Chrome; then it waits up to `cleanupTimeoutMs` for Playwright's
 * close to finish and removes what is left of that browser's own folders. A close that fails
 * counts as closed: the work is done.
 */
export async function closeStudioBrowser(browser: Browser, options: {timeoutMs?: number; cleanupTimeoutMs?: number} = {}): Promise<BrowserCloseResult> {
  const started = Date.now();
  const closing = browser.close();
  const closed = await settlesWithin(closing, options.timeoutMs ?? CLOSE_TIMEOUT_MS);
  const record = launched.get(browser);
  if (closed || !record) return {closed, elapsedMs: Date.now() - started, killed: []};
  const killed = (await killLaunchedBrowser(record.marker)).map((child) => child.pid);
  const elapsedMs = Date.now() - started;
  const settled = await settlesWithin(closing, options.cleanupTimeoutMs ?? CLEANUP_TIMEOUT_MS);
  const waitedMs = Date.now() - started - elapsedMs;
  return {closed, elapsedMs, killed, cleanup: {settled, waitedMs, ...await removeLaunchFolders(record.folders, record.temporary)}};
}

/** The line a caller prints for a close that ran out of time: `killed PID 123 after 10054 ms; Playwright's close …`. */
export function closeTimeoutDetail(result: BrowserCloseResult): string {
  const killed = `killed PID ${result.killed.join(", ") || "none found"} after ${result.elapsedMs} ms`;
  return result.cleanup ? `${killed}; ${describeCleanup("close", result.cleanup)}` : killed;
}

/** SIGKILLs the process group of this process's child Chrome that carries `marker`, and says which, with its command line. POSIX only. */
async function killLaunchedBrowser(marker: string): Promise<{pid: number; command: string}[]> {
  let listing: string;
  try {
    ({stdout: listing} = await execFileAsync("ps", ["-axww", "-o", "pid=,ppid=,command="], {maxBuffer: 32 * 1024 * 1024}));
  } catch {
    return [];
  }
  const found = listing.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return match && Number(match[2]) === process.pid && ` ${match[3]} `.includes(` ${marker} `) ? [{pid: Number(match[1]), command: match[3]!}] : [];
  });
  for (const {pid} of found) {
    // Playwright starts Chrome as the leader of its own process group, which holds its helpers too.
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
  return found;
}

/** A Google Fonts answer the trusted process fulfills itself; nothing is fetched from the network. */
export interface FontRouteAnswer {
  status: number;
  contentType: string;
  body: Buffer;
}

/**
 * Answers a GET to `fonts.googleapis.com` or `fonts.gstatic.com` from trusted local data, or
 * returns `undefined` for a miss. It is only ever used with `route.fulfill`: requests are never
 * continued or fetched. Hosted renders plug the job's font package (`FontResolver`) in here.
 */
export type FontRoute = (url: string) => Promise<FontRouteAnswer | undefined>;

/** The part of a Playwright `Route` that `serveFontRequest` may use. `continue` and `fetch` are deliberately absent. */
export interface FontRequestRoute {
  request(): {method(): string; url(): string};
  fulfill(response: {status: number; contentType: string; body: Buffer; headers: Record<string, string>}): Promise<void>;
  abort(errorCode?: string): Promise<void>;
}

/**
 * Serves one Google Fonts request from trusted data. Only GETs to URLs the canonicalizer accepts
 * are looked up; anything else is blocked. A hit, or a recorded upstream 4xx, is fulfilled with its
 * status; a miss is aborted as `failed`. It never calls `route.continue` or `route.fetch`.
 */
export async function serveFontRequest(route: FontRequestRoute, fontRoute: FontRoute): Promise<void> {
  const request = route.request();
  if (request.method() !== "GET" || !canonicalGoogleFontsUrl(request.url()).ok) {
    await route.abort("blockedbyclient");
    return;
  }
  const answer = await fontRoute(request.url());
  if (!answer) {
    await route.abort("failed");
    return;
  }
  // @font-face loads in CORS mode from the loopback frame origin.
  await route.fulfill({
    status: answer.status,
    contentType: answer.contentType,
    body: answer.body,
    headers: {"access-control-allow-origin": "*", "cache-control": "public, max-age=31536000, immutable"}
  });
}

export function isGoogleFontsRequestUrl(url: string): boolean {
  try {
    return isGoogleFontsHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * The shortest page the Studio opens. Headless Chrome 154 (macOS) never answers a screenshot of a page
 * shorter than 88 px once the page has been idle for a few hundred milliseconds (2026-10-04), so a shorter
 * scene is drawn at the top of a page this tall, and its screenshot is clipped to the scene.
 */
export const MIN_PAGE_HEIGHT = 120;

/** The page viewport for content of `size`: the same width, and the same height but never below MIN_PAGE_HEIGHT. */
export function pageViewport(size: {width: number; height: number}): {width: number; height: number} {
  return {width: size.width, height: Math.max(size.height, MIN_PAGE_HEIGHT)};
}

export async function createIsolatedContext(options: {
  browser: Browser;
  allowedOrigins: string[];
  /** The content size; the page is never shorter than MIN_PAGE_HEIGHT. */
  viewport: {width: number; height: number};
  deviceScaleFactor?: number;
  fontRoute?: FontRoute;
}): Promise<BrowserContext> {
  const context = await options.browser.newContext({
    viewport: pageViewport(options.viewport),
    deviceScaleFactor: options.deviceScaleFactor ?? 1,
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: "light",
    reducedMotion: "no-preference",
    serviceWorkers: "block",
    acceptDownloads: false
  });
  const allowed = new Set(options.allowedOrigins);
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === "data:" || url.protocol === "blob:" || allowed.has(url.origin)) {
      await route.continue();
      return;
    }
    if (options.fontRoute && isGoogleFontsHost(url.hostname)) {
      await serveFontRequest(route, options.fontRoute);
      return;
    }
    await route.abort("blockedbyclient");
  });
  await context.routeWebSocket(/.*/, async (webSocket) => {
    await webSocket.close({code: 1008, reason: "External WebSockets are disabled by SE Widget Studio."});
  });
  context.on("page", (page) => {
    if (context.pages()[0] !== page) void page.close();
  });
  return context;
}

/** A Google Fonts request that did not load: blocked or failed (`status` absent), or answered with an error status. */
export interface FontRequestIssue {
  url: string;
  status?: number;
  detail: string;
  /**
   * Chrome aborted the request (`net::ERR_ABORTED`). It happens when the document drops the
   * stylesheet, for example when a widget points the link at another font before this one loaded.
   */
  aborted?: boolean;
}

export interface BrowserIssueLog {
  errors: string[];
  warnings: string[];
  /** Google Fonts failures, kept apart from `errors` so they become font codes instead of a generic runtime error. */
  fonts: FontRequestIssue[];
  /** Google Fonts requests the page made that have not finished or failed yet (for timeout messages). */
  pendingFonts: Set<string>;
  /**
   * Call before the widget frame is replaced by a field reload. Requests the replaced document still
   * had in flight end as `net::ERR_ABORTED`; they are the reload's doing, not failures of the widget.
   */
  replacingFrame: () => void;
}

const CSP_REFUSAL = /^Refused to load the (?:stylesheet|font) '([^']+)'/;
const issueLogs = new WeakMap<Page, BrowserIssueLog>();

/** The issue log observePage() keeps for `page`, for a timeout message that names what was pending. */
export function pageIssues(page: Page): BrowserIssueLog | undefined {
  return issueLogs.get(page);
}

export function observePage(page: Page): BrowserIssueLog {
  // Each field reload starts a generation; an abort of a request from an earlier one is the reload's.
  let generation = 0;
  const issuedIn = new WeakMap<Request, number>();
  const log: BrowserIssueLog = {errors: [], warnings: [], fonts: [], pendingFonts: new Set(), replacingFrame: () => {
    generation += 1;
  }};
  issueLogs.set(page, log);
  page.on("request", (request) => {
    issuedIn.set(request, generation);
    if (isGoogleFontsRequestUrl(request.url())) log.pendingFonts.add(request.url());
  });
  page.on("requestfinished", (request) => {
    log.pendingFonts.delete(request.url());
    // A later request for the same URL got an answer: an earlier abort of it cost nothing.
    for (let index = log.fonts.length - 1; index >= 0; index -= 1) {
      if (log.fonts[index]?.aborted && log.fonts[index]?.url === request.url()) log.fonts.splice(index, 1);
    }
  });
  const noteFont = (issue: FontRequestIssue) => {
    const index = log.fonts.findIndex((known) => known.url === issue.url && known.status === issue.status);
    if (index === -1) log.fonts.push(issue);
    else if (log.fonts[index]?.aborted && !issue.aborted) log.fonts[index] = issue;
  };
  page.on("pageerror", (error) => log.errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    const text = message.text();
    // "Failed to load resource … 400" omits the URL; it is in the message location instead.
    const refused = CSP_REFUSAL.exec(text)?.[1];
    if (refused && isGoogleFontsRequestUrl(refused)) {
      noteFont({url: refused, detail: "refused by the content security policy"});
      return;
    }
    if (isGoogleFontsRequestUrl(message.location().url)) return;
    if (message.type() === "error") log.errors.push(`console.error: ${text}`);
    if (message.type() === "warning") log.warnings.push(`console.warn: ${text}`);
  });
  page.on("requestfailed", (request) => {
    log.pendingFonts.delete(request.url());
    const failure = request.failure()?.errorText ?? "request failed";
    if (failure === "net::ERR_ABORTED" && (issuedIn.get(request) ?? generation) < generation) return;
    if (isGoogleFontsRequestUrl(request.url())) {
      noteFont({url: request.url(), detail: failure, ...(failure === "net::ERR_ABORTED" ? {aborted: true} : {})});
      return;
    }
    log.errors.push(`requestfailed: ${request.url()} (${failure})`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400 && isGoogleFontsRequestUrl(response.url())) {
      noteFont({url: response.url(), status: response.status(), detail: `HTTP ${response.status()}`});
    }
  });
  return log;
}
