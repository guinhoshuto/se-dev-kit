import {readFile} from "node:fs/promises";
import type {VideoDefinition} from "../types.js";
import {StudioError} from "../shared/errors.js";
import {createAtomicTarget} from "./output.js";
import {findExecutable, runExecutable, toolVersion} from "../validation/tools.js";

export interface MediaTooling {
  ffmpegPath?: string;
  ffprobePath?: string;
  ffmpegVersion?: string;
  ffprobeVersion?: string;
}

export async function detectMediaTooling(options: {
  ffmpegPath?: string;
  ffprobePath?: string;
} = {}): Promise<MediaTooling> {
  const ffmpegPath = await findExecutable("ffmpeg", options.ffmpegPath);
  const ffprobePath = await findExecutable("ffprobe", options.ffprobePath);
  const tooling: MediaTooling = {};
  if (ffmpegPath) tooling.ffmpegPath = ffmpegPath;
  if (ffprobePath) tooling.ffprobePath = ffprobePath;
  const [ffmpegVersion, ffprobeVersion] = await Promise.all([toolVersion(ffmpegPath), toolVersion(ffprobePath)]);
  if (ffmpegVersion) tooling.ffmpegVersion = ffmpegVersion;
  if (ffprobeVersion) tooling.ffprobeVersion = ffprobeVersion;
  return tooling;
}

export async function encodeFrameSequence(options: {
  outputRoot: string;
  framePattern: string;
  outputPath: string;
  video: VideoDefinition;
  force: boolean;
  tooling: MediaTooling;
  expectedWidth: number;
  expectedHeight: number;
  maximumBytes?: number;
}): Promise<{status: "final" | "intermediate" | "unvalidated"; metadata?: unknown}> {
  if (!options.tooling.ffmpegPath) return {status: "intermediate"};
  const atomic = await createAtomicTarget(options.outputRoot, options.outputPath);
  const format = options.video.format ?? "mp4";
  const codec = options.video.codec ?? (format === "mp4" ? "h264" : "vp9");
  const codecName = codec === "h264" ? "libx264" : "libvpx-vp9";
  const args = [
    options.force ? "-y" : "-n",
    "-framerate",
    String(options.video.fps),
    "-i",
    options.framePattern,
    "-t",
    (options.video.durationMs / 1000).toFixed(3),
    "-an",
    "-c:v",
    codecName,
    "-pix_fmt",
    options.video.pixelFormat ?? "yuv420p"
  ];
  if (format === "mp4") args.push("-movflags", "+faststart", "-f", "mp4");
  else args.push("-f", "webm");
  args.push(atomic.temporaryPath);
  const encoded = await runExecutable(options.tooling.ffmpegPath, args, {maxOutputBytes: 250_000});
  if (encoded.code !== 0) {
    throw new StudioError("FFMPEG_FAILED", `FFmpeg exited with code ${encoded.code}: ${encoded.stderr.slice(-4000)}`);
  }

  let metadata: unknown;
  if (options.tooling.ffprobePath) {
    const probe = await runExecutable(options.tooling.ffprobePath, [
      "-v",
      "error",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      atomic.temporaryPath
    ]);
    if (probe.code !== 0) {
      throw new StudioError("FFPROBE_FAILED", `ffprobe exited with code ${probe.code}: ${probe.stderr.slice(-4000)}`);
    }
    metadata = JSON.parse(probe.stdout) as unknown;
    const parsed = metadata as {
      streams?: {codec_type?: string; codec_name?: string; width?: number; height?: number; pix_fmt?: string; avg_frame_rate?: string; duration?: string; tags?: {alpha_mode?: string}}[];
      format?: {duration?: string};
    };
    const videoStreams = (parsed.streams ?? []).filter((stream) => stream.codec_type === "video");
    const audioStreams = (parsed.streams ?? []).filter((stream) => stream.codec_type === "audio");
    const stream = videoStreams[0];
    if (!stream || videoStreams.length !== 1 || audioStreams.length !== 0) {
      throw new StudioError("VIDEO_METADATA_INVALID", "Encoded output must contain exactly one video stream and no audio streams.");
    }
    if (stream.width !== options.expectedWidth || stream.height !== options.expectedHeight) {
      throw new StudioError(
        "VIDEO_DIMENSIONS_INVALID",
        `Encoded output is ${stream.width ?? "unknown"}x${stream.height ?? "unknown"}; expected ${options.expectedWidth}x${options.expectedHeight}.`
      );
    }
    const expectedCodec = codec === "h264" ? "h264" : "vp9";
    const expectedPixelFormat = options.video.pixelFormat ?? "yuv420p";
    const pixelFormatMatches = stream.pix_fmt === expectedPixelFormat || (
      expectedPixelFormat === "yuva420p" && stream.pix_fmt === "yuv420p" && stream.tags?.alpha_mode === "1"
    );
    if (stream.codec_name !== expectedCodec || !pixelFormatMatches) {
      throw new StudioError(
        "VIDEO_CODEC_INVALID",
        `Encoded output uses ${stream.codec_name ?? "unknown"}/${stream.pix_fmt ?? "unknown"}; expected ${expectedCodec}/${expectedPixelFormat}.`
      );
    }
    const [rateNumerator, rateDenominator] = (stream.avg_frame_rate ?? "0/1").split("/").map(Number);
    const actualFps = (rateNumerator ?? 0) / ((rateDenominator ?? 1) || 1);
    if (Math.abs(actualFps - options.video.fps) > 0.1) {
      throw new StudioError("VIDEO_FPS_INVALID", `Encoded output is ${actualFps} FPS; expected ${options.video.fps}.`);
    }
    const actualDuration = Number(stream.duration ?? parsed.format?.duration ?? 0);
    const expectedDuration = options.video.durationMs / 1000;
    if (!Number.isFinite(actualDuration) || Math.abs(actualDuration - expectedDuration) > Math.max(0.25, 1 / options.video.fps)) {
      throw new StudioError(
        "VIDEO_DURATION_INVALID",
        `Encoded output duration is ${actualDuration}s; expected approximately ${expectedDuration}s.`
      );
    }
  }
  const encodedBytes = await readFile(atomic.temporaryPath);
  if (options.maximumBytes && encodedBytes.byteLength > options.maximumBytes) {
    throw new StudioError(
      "VIDEO_FILE_TOO_LARGE",
      `Encoded output is ${encodedBytes.byteLength} bytes; the selected marketplace preset allows at most ${options.maximumBytes} bytes.`
    );
  }
  await atomic.commit();
  return options.tooling.ffprobePath ? {status: "final", metadata} : {status: "unvalidated"};
}
