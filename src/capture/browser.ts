import {access, realpath} from "node:fs/promises";
import {constants} from "node:fs";
import {platform} from "node:os";
import {chromium, type Browser, type BrowserContext, type Page} from "playwright-core";
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
 * kill-stale` finds this checkout's orphans by it without touching another session's Chrome.
 */
export const BROWSER_MARKER = "--se-widget-studio";
let launches = 0;

export async function launchStudioBrowser(options: {
  browserPath?: string;
  headed?: boolean;
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
  const browser = await chromium.launch({
    executablePath: detection.executablePath,
    headless: !options.headed,
    args: [`${BROWSER_MARKER}=${process.pid}-${launches}`]
  });
  return {browser, detection};
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
