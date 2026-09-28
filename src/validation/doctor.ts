import {access} from "node:fs/promises";
import {constants} from "node:fs";
import type {Diagnostic, ResolvedProject} from "../types.js";
import {detectBrowser, type BrowserDetection} from "../capture/browser.js";
import {nearestExistingAncestor} from "../shared/paths.js";
import {findExecutable, toolVersion} from "./tools.js";
import {satisfiesNodeRange} from "../shared/node-support.js";

// H.264/AAC video. Chromium builds without proprietary codecs (Playwright's, and the hosted
// Sandbox's HeadlessChrome) fire `error` on it, and the capture then fails with "Video failed to load".
const PROPRIETARY_VIDEO = /\.(?:mp4|m4v|mov)(?:[?#].*)?$/i;

/** Whether the detected browser is a Chromium build, which usually ships without H.264. */
export function lacksProprietaryCodecs(browser: BrowserDetection): boolean {
  return browser.source === "playwright-cache" || /ms-playwright|chromium|headless_shell/i.test(browser.executablePath ?? "");
}

/** MP4/MOV references in the field defaults and the catalog, sorted and without duplicates. */
export function proprietaryVideoReferences(project: ResolvedProject): string[] {
  const found = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      if (PROPRIETARY_VIDEO.test(value)) found.add(value);
    } else if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value && typeof value === "object") {
      Object.values(value).forEach(visit);
    }
  };
  visit(project.fieldDefaults);
  for (const list of [project.themes, project.fixtures, project.scenes, project.scenarios]) {
    for (const item of list) visit(item.value);
  }
  return [...found].sort();
}

export interface DoctorReport {
  diagnostics: Diagnostic[];
  tools: {
    node: {version: string; supported: boolean};
    browser: Awaited<ReturnType<typeof detectBrowser>>;
    ffmpeg: {path?: string; version?: string};
    ffprobe: {path?: string; version?: string};
  };
}

export async function runDoctor(options: {
  project?: ResolvedProject;
  browserPath?: string;
  ffmpegPath?: string;
  ffprobePath?: string;
} = {}): Promise<DoctorReport> {
  const diagnostics: Diagnostic[] = [];
  const nodeSupported = satisfiesNodeRange(process.versions.node);
  diagnostics.push({
    status: nodeSupported ? "ok" : "error",
    code: "NODE_VERSION",
    detail: `Node.js ${process.versions.node} is ${nodeSupported ? "supported" : "outside the supported >=22.20 <23 or >=24 <25 ranges"}.`
  });

  const browser = await detectBrowser(options.browserPath);
  diagnostics.push(
    browser.executablePath
      ? {status: "ok", code: "BROWSER", detail: `Browser detected from ${browser.source}: ${browser.executablePath}`}
      : {
          status: "warning",
          code: "BROWSER_MISSING",
          detail: "No compatible Chromium or Chrome executable was detected.",
          hint: "Install a system browser yourself and pass --browser-path or set SE_WIDGET_STUDIO_BROWSER."
        }
  );
  const videos = options.project && browser.executablePath && lacksProprietaryCodecs(browser)
    ? proprietaryVideoReferences(options.project)
    : [];
  if (videos.length) {
    const shown = videos.slice(0, 3).join(", ") + (videos.length > 3 ? `, and ${videos.length - 3} more` : "");
    diagnostics.push({
      status: "warning",
      code: "BROWSER_NO_H264",
      detail: `The browser is a Chromium build without H.264, and the catalog uses MP4/MOV video (${shown}). Such a video fails to load there, and the capture fails with "Video failed to load".`,
      hint: "Pass --browser-path with Google Chrome, or use WebM (VP9) test media. Hosted jobs run a Chromium build too: use WebM there."
    });
  }

  const ffmpegPath = await findExecutable("ffmpeg", options.ffmpegPath);
  const ffprobePath = await findExecutable("ffprobe", options.ffprobePath);
  const ffmpegVersion = await toolVersion(ffmpegPath);
  const ffprobeVersion = await toolVersion(ffprobePath);
  diagnostics.push(
    ffmpegPath
      ? {status: "ok", code: "FFMPEG", detail: ffmpegVersion ?? `FFmpeg detected: ${ffmpegPath}`}
      : {
          status: "warning",
          code: "FFMPEG_MISSING",
          detail: "FFmpeg was not detected. Video commands will keep a numbered PNG sequence and frames manifest."
        }
  );
  diagnostics.push(
    ffprobePath
      ? {status: "ok", code: "FFPROBE", detail: ffprobeVersion ?? `ffprobe detected: ${ffprobePath}`}
      : {
          status: "warning",
          code: "FFPROBE_MISSING",
          detail: "ffprobe was not detected. Encoded videos cannot receive local metadata validation."
        }
  );

  if (options.project) {
    try {
      const ancestor = await nearestExistingAncestor(options.project.outputRoot);
      await access(ancestor, constants.W_OK);
      diagnostics.push({status: "ok", code: "OUTPUT_WRITABLE", detail: "The resolved output ancestor is writable."});
    } catch (error) {
      diagnostics.push({
        status: "error",
        code: "OUTPUT_NOT_WRITABLE",
        detail: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const tools: DoctorReport["tools"] = {
    node: {version: process.versions.node, supported: nodeSupported},
    browser,
    ffmpeg: {},
    ffprobe: {}
  };
  if (ffmpegPath) tools.ffmpeg.path = ffmpegPath;
  if (ffmpegVersion) tools.ffmpeg.version = ffmpegVersion;
  if (ffprobePath) tools.ffprobe.path = ffprobePath;
  if (ffprobeVersion) tools.ffprobe.version = ffprobeVersion;
  return {diagnostics, tools};
}
