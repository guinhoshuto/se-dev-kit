import {access} from "node:fs/promises";
import {constants} from "node:fs";
import type {Diagnostic, ResolvedProject} from "../types.js";
import {detectBrowser} from "../capture/browser.js";
import {nearestExistingAncestor} from "../shared/paths.js";
import {findExecutable, toolVersion} from "./tools.js";

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
  const [nodeMajor = 0, nodeMinor = 0] = process.versions.node.split(".").map(Number);
  const nodeSupported = (nodeMajor === 22 && nodeMinor >= 20) || nodeMajor === 24;
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
