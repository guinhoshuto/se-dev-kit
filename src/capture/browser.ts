import {execFile} from "node:child_process";
import {access, realpath} from "node:fs/promises";
import {constants} from "node:fs";
import {platform} from "node:os";
import {promisify} from "node:util";
import {chromium, errors, type Browser, type BrowserContext, type Page} from "playwright-core";
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
const markers = new WeakMap<Browser, string>();

/** How long Chrome may take to start before the launch fails and the process it started is killed. */
export const LAUNCH_TIMEOUT_MS = 30_000;
/** How long `browser.close()` may take before the browser's process group is killed. */
export const CLOSE_TIMEOUT_MS = 10_000;
// Room for Playwright to report its own launch timeout first. It may not: on its timeout it waits for
// the process to close gracefully, which a hung browser never does (a fake one held it for 30 s).
const LAUNCH_GRACE_MS = 5_000;
const OUTER_DEADLINE = Symbol("launch deadline");

const execFileAsync = promisify(execFile);

export async function launchStudioBrowser(options: {
  browserPath?: string;
  headed?: boolean;
  launchTimeoutMs?: number;
} = {}): Promise<{browser: Browser; detection: BrowserDetection}> {
  const detection = await detectBrowser(options.browserPath);
  if (!detection.executablePath) {
    throw new StudioError(
      "BROWSER_NOT_FOUND",
      "No compatible Chromium or Chrome executable was found.",
      "Install a system Chrome/Chromium yourself, then pass --browser-path /absolute/path or set SE_WIDGET_STUDIO_BROWSER. The Studio never downloads browsers automatically."
    );
  }
  launches += 1;
  const marker = `${BROWSER_MARKER}=${process.pid}-${launches}`;
  const timeout = options.launchTimeoutMs ?? LAUNCH_TIMEOUT_MS;
  const launchTimeout = () => new StudioError(
    "BROWSER_LAUNCH_TIMEOUT",
    `Chrome did not start within ${timeout / 1000} s (${detection.executablePath}).`,
    "The machine may be busy with another render: check for running headless Chrome, wait, and retry. The process this launch started was killed."
  );
  const launching = chromium.launch({executablePath: detection.executablePath, headless: !options.headed, args: [marker], timeout});
  let deadline: NodeJS.Timeout | undefined;
  try {
    const browser = await Promise.race([
      launching,
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(OUTER_DEADLINE), timeout + LAUNCH_GRACE_MS);
      })
    ]);
    markers.set(browser, marker);
    return {browser, detection};
  } catch (error) {
    // A launch that settles after the deadline must not leave its browser running.
    launching.then((late) => late.close()).catch(() => undefined);
    if (error !== OUTER_DEADLINE && !(error instanceof errors.TimeoutError)) throw error;
    await killLaunchedBrowser(marker);
    throw launchTimeout();
  } finally {
    clearTimeout(deadline);
  }
}

export interface BrowserCloseResult {
  /** False when the close ran out of time and the browser was killed instead. */
  closed: boolean;
  elapsedMs: number;
  killed: number[];
}

/**
 * Closes a browser from launchStudioBrowser within `timeoutMs`. A close that hangs kills the
 * browser's process group (found by its marker among this process's children), so a finished
 * render never waits forever on Chrome. A close that fails counts as closed: the work is done.
 */
export async function closeStudioBrowser(browser: Browser, options: {timeoutMs?: number} = {}): Promise<BrowserCloseResult> {
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const closed = await Promise.race([
    browser.close().then(() => true, () => true),
    new Promise<false>((resolveClose) => {
      timer = setTimeout(() => resolveClose(false), options.timeoutMs ?? CLOSE_TIMEOUT_MS);
    })
  ]);
  clearTimeout(timer);
  const marker = markers.get(browser);
  const killed = closed || !marker ? [] : await killLaunchedBrowser(marker);
  return {closed, elapsedMs: Date.now() - started, killed};
}

/** SIGKILLs the process group of this process's child Chrome that carries `marker`. POSIX only. */
async function killLaunchedBrowser(marker: string): Promise<number[]> {
  let listing: string;
  try {
    ({stdout: listing} = await execFileAsync("ps", ["-axww", "-o", "pid=,ppid=,command="], {maxBuffer: 32 * 1024 * 1024}));
  } catch {
    return [];
  }
  const pids = listing.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return match && Number(match[2]) === process.pid && ` ${match[3]} `.includes(` ${marker} `) ? [Number(match[1])] : [];
  });
  for (const pid of pids) {
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
  return pids;
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

export async function createIsolatedContext(options: {
  browser: Browser;
  allowedOrigins: string[];
  viewport: {width: number; height: number};
  deviceScaleFactor?: number;
  fontRoute?: FontRoute;
}): Promise<BrowserContext> {
  const context = await options.browser.newContext({
    viewport: options.viewport,
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
}

export interface BrowserIssueLog {
  errors: string[];
  warnings: string[];
  /** Google Fonts failures, kept apart from `errors` so they become font codes instead of a generic runtime error. */
  fonts: FontRequestIssue[];
  /** Google Fonts requests the page made that have not finished or failed yet (for timeout messages). */
  pendingFonts: Set<string>;
}

const CSP_REFUSAL = /^Refused to load the (?:stylesheet|font) '([^']+)'/;

export function observePage(page: Page): BrowserIssueLog {
  const log: BrowserIssueLog = {errors: [], warnings: [], fonts: [], pendingFonts: new Set()};
  page.on("request", (request) => {
    if (isGoogleFontsRequestUrl(request.url())) log.pendingFonts.add(request.url());
  });
  page.on("requestfinished", (request) => log.pendingFonts.delete(request.url()));
  const noteFont = (issue: FontRequestIssue) => {
    if (!log.fonts.some((known) => known.url === issue.url && known.status === issue.status)) log.fonts.push(issue);
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
    if (isGoogleFontsRequestUrl(request.url())) {
      noteFont({url: request.url(), detail: failure});
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
