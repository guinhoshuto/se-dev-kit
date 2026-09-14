import {access, realpath} from "node:fs/promises";
import {constants} from "node:fs";
import {platform} from "node:os";
import {chromium, type Browser, type BrowserContext, type Page} from "playwright-core";
import {StudioError} from "../shared/errors.js";

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
  const cached = chromium.executablePath();
  if (cached) candidates.push({path: cached, source: "playwright-cache"});
  for (const path of SYSTEM_PATHS[platform()] ?? []) candidates.push({path, source: "system"});

  for (const candidate of candidates) {
    checked.push(candidate.path);
    if (await executable(candidate.path)) {
      return {executablePath: await realpath(candidate.path), source: candidate.source, checked};
    }
  }
  return {checked};
}

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
  const browser = await chromium.launch({
    executablePath: detection.executablePath,
    headless: !options.headed
  });
  return {browser, detection};
}

export async function createIsolatedContext(options: {
  browser: Browser;
  allowedOrigins: string[];
  viewport: {width: number; height: number};
  deviceScaleFactor?: number;
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

export interface BrowserIssueLog {
  errors: string[];
  warnings: string[];
}

export function observePage(page: Page): BrowserIssueLog {
  const log: BrowserIssueLog = {errors: [], warnings: []};
  page.on("pageerror", (error) => log.errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") log.errors.push(`console.error: ${message.text()}`);
    if (message.type() === "warning") log.warnings.push(`console.warn: ${message.text()}`);
  });
  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText ?? "request failed";
    log.errors.push(`requestfailed: ${request.url()} (${failure})`);
  });
  return log;
}
