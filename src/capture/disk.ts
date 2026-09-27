import {statfs as nodeStatfs} from "node:fs/promises";
import type {RecipeDefinition} from "../types.js";
import {StudioError, toErrorMessage} from "../shared/errors.js";
import {nearestExistingAncestor} from "../shared/paths.js";

/**
 * Conservative estimate for one PNG still or frame, in thousandths of a byte per output pixel (1.2 B/px).
 * Measured renders used 0.70 B/px (21 desktop-theme videos, 2026-09-25) and 0.076 B/px
 * (a 28-second tutorial, 2026-09-26). Captures use CSS scale, so a PNG has exactly the
 * `crop ?? output` pixel count; the device scale factor does not multiply it.
 */
export const PNG_MILLIBYTES_PER_PIXEL = 1_200;
/**
 * Estimate for one tutorial-mode video frame (0.3 B/px). Tutorial frames are mostly flat UI; the 28-second
 * tutorial measured 0.076 B/px, so this keeps about four times that margin without refusing renders that fit.
 */
export const TUTORIAL_FRAME_MILLIBYTES_PER_PIXEL = 300;
/** Upper bound for encoded video, in thousandths of a byte per output pixel per frame (0.05 B/px). */
export const VIDEO_MILLIBYTES_PER_PIXEL = 50;
/** Bytes reserved per frame record in frames.json and in the manifest's copy of it (about 156 measured). */
export const FRAME_RECORD_BYTES = 256;
/** Bytes reserved for the manifest before per-variant entries. */
export const MANIFEST_BASE_BYTES = 262_144;
/** Bytes reserved per variant entry in the manifest, excluding frame records. */
export const MANIFEST_VARIANT_BYTES = 4_096;
/** A render may use at most this percentage of the free space measured on the output volume. */
export const DISK_BUDGET_PERCENT = 70;

export interface VariantByteEstimate {
  id: string;
  frames: number;
  /** PNG frames plus frames.json; removed after a validated encode unless frames are kept. */
  frameBytes: number;
  /** Still, thumbnail, and encoded video. */
  persistentBytes: number;
  totalBytes: number;
}

export interface RenderByteEstimate {
  /** `png` for stills, `frame` for video frames (lower in tutorial mode), `video` per frame of encoded video. */
  bytesPerPixel: {png: number; frame: number; video: number};
  /** True when frames are expected to be removed after each validated encode. */
  discardFrames: boolean;
  variants: VariantByteEstimate[];
  contactSheetBytes: number;
  manifestBytes: number;
  /** Every byte the render writes if nothing is removed. */
  totalBytes: number;
  /** Bytes left on disk after a successful render. */
  finalBytes: number;
  /** Most bytes on disk at once. Discarded frames exist for one variant at a time. */
  peakBytes: number;
}

export interface DiskBudget {
  /** Nearest existing ancestor of the output root, where free space was measured. */
  path: string;
  freeBytes: number;
  budgetPercent: number;
  budgetBytes: number;
  peakBytes: number;
  withinBudget: boolean;
  summary: string;
}

export type StatfsFunction = (path: string) => Promise<{bavail: number | bigint; bsize: number | bigint}>;

export interface ByteEstimateInput {
  outputs: RecipeDefinition["outputs"];
  /** Final pixel size of each variant: `crop ?? output`. */
  variants: {id: string; width: number; height: number}[];
  framesPerVariant: number;
  /** True when FFmpeg was found, so an encoded video is written. */
  includeVideo: boolean;
  discardFrames: boolean;
  maximumVideoBytes?: number;
}

function pngBytes(width: number, height: number, millibytesPerPixel = PNG_MILLIBYTES_PER_PIXEL): number {
  return Math.ceil((width * height * millibytesPerPixel) / 1000);
}

/** Pure estimate of the bytes a render writes, per variant and in total. */
export function estimateRenderBytes(input: ByteEstimateInput): RenderByteEstimate {
  const screenshots = input.outputs?.screenshots !== false;
  const thumbnail = input.outputs?.thumbnails;
  const video = input.outputs?.video?.enabled ? input.outputs.video : undefined;
  const frames = video ? input.framesPerVariant : 0;
  const frameRate = video?.mode === "tutorial" ? TUTORIAL_FRAME_MILLIBYTES_PER_PIXEL : PNG_MILLIBYTES_PER_PIXEL;
  const variants = input.variants.map((variant): VariantByteEstimate => {
    const stillBytes = screenshots ? pngBytes(variant.width, variant.height) : 0;
    const thumbnailBytes = screenshots && thumbnail ? pngBytes(thumbnail.width, thumbnail.height) : 0;
    const frameBytes = frames * (pngBytes(variant.width, variant.height, frameRate) + FRAME_RECORD_BYTES);
    let videoBytes = video && input.includeVideo
      ? Math.ceil((frames * variant.width * variant.height * VIDEO_MILLIBYTES_PER_PIXEL) / 1000)
      : 0;
    if (input.maximumVideoBytes !== undefined) videoBytes = Math.min(videoBytes, input.maximumVideoBytes);
    const persistentBytes = stillBytes + thumbnailBytes + videoBytes;
    return {id: variant.id, frames, frameBytes, persistentBytes, totalBytes: frameBytes + persistentBytes};
  });
  const sheetItems = screenshots && input.outputs?.contactSheet ? variants.length : 0;
  const contactSheetBytes = sheetItems > 0
    ? pngBytes(1600, 80 + Math.ceil(sheetItems / Math.min(3, sheetItems)) * 390)
    : 0;
  const manifestBytes = MANIFEST_BASE_BYTES + variants.length * MANIFEST_VARIANT_BYTES + variants.length * frames * FRAME_RECORD_BYTES;
  const totalBytes = variants.reduce((sum, variant) => sum + variant.totalBytes, 0) + contactSheetBytes + manifestBytes;
  const allFrameBytes = variants.reduce((sum, variant) => sum + variant.frameBytes, 0);
  const largestFrameBytes = variants.reduce((largest, variant) => Math.max(largest, variant.frameBytes), 0);
  const finalBytes = input.discardFrames ? totalBytes - allFrameBytes : totalBytes;
  return {
    bytesPerPixel: {
      png: PNG_MILLIBYTES_PER_PIXEL / 1000,
      frame: frameRate / 1000,
      video: VIDEO_MILLIBYTES_PER_PIXEL / 1000
    },
    discardFrames: input.discardFrames,
    variants,
    contactSheetBytes,
    manifestBytes,
    totalBytes,
    finalBytes,
    peakBytes: input.discardFrames ? finalBytes + largestFrameBytes : totalBytes
  };
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB"];
  let value = bytes;
  let unit = 0;
  while (Math.abs(value) >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${bytes} B` : `${value.toFixed(1)} ${units[unit]}`;
}

/** Measures free space for unprivileged writes on the volume that will hold the output root. */
export async function measureFreeSpace(
  outputRoot: string,
  statfs: StatfsFunction = nodeStatfs
): Promise<{path: string; freeBytes: number}> {
  const path = await nearestExistingAncestor(outputRoot);
  const stats = await statfs(path);
  return {path, freeBytes: Number(stats.bavail) * Number(stats.bsize)};
}

export function diskBudget(path: string, freeBytes: number, peakBytes: number): DiskBudget {
  const budgetBytes = Math.floor((freeBytes * DISK_BUDGET_PERCENT) / 100);
  const withinBudget = peakBytes <= budgetBytes;
  return {
    path,
    freeBytes,
    budgetPercent: DISK_BUDGET_PERCENT,
    budgetBytes,
    peakBytes,
    withinBudget,
    summary: `Estimated peak ${formatBytes(peakBytes)} with ${formatBytes(freeBytes)} free on ${path}; the limit is ${DISK_BUDGET_PERCENT}% of free space (${formatBytes(budgetBytes)}).${
      withinBudget ? "" : " A render stops here unless --allow-low-disk is passed."
    }`
  };
}

export function assertDiskBudget(recipeId: string, budget: DiskBudget, allowLowDisk: boolean): void {
  if (budget.withinBudget || allowLowDisk) return;
  throw new StudioError(
    "OUTPUT_DISK_LOW",
    `Recipe "${recipeId}" needs an estimated peak of ${formatBytes(budget.peakBytes)} (${budget.peakBytes} bytes) on ${budget.path}, which has ${formatBytes(budget.freeBytes)} (${budget.freeBytes} bytes) free. A render may use at most ${budget.budgetPercent}% of free space (${formatBytes(budget.budgetBytes)}).`,
    "Free disk space, reduce the matrix, duration, FPS, or output size, or pass --allow-low-disk after reviewing the estimate from --dry-run."
  );
}

/** True for ENOSPC from Node, Playwright, or FFmpeg output, including wrapped causes. */
export function isNoSpaceError(error: unknown, depth = 0): boolean {
  if (typeof error !== "object" || error === null || depth > 4) return false;
  if ((error as {code?: unknown}).code === "ENOSPC") return true;
  if (error instanceof Error && /\bENOSPC\b|No space left on device/i.test(error.message)) return true;
  return isNoSpaceError((error as {cause?: unknown}).cause, depth + 1);
}

export interface RenderProgress {
  recipeDirectory: string;
  totalVariants: number;
  completedVariants: string[];
  variant?: string;
  step: string;
  framesWritten: number;
  framesPlanned: number;
  framesDirectory?: string;
}

/** Plain-language account of a disk-full stop: what happened and what was left behind. */
export function describeDiskFull(details: {
  progress: RenderProgress;
  removedTemporaryFiles: number;
  peakBytes: number;
  freeBytes?: number;
  cause: unknown;
}): string {
  const {progress} = details;
  const where = progress.variant ? `the ${progress.step} of variant "${progress.variant}"` : `the ${progress.step}`;
  const frames = progress.variant && progress.framesPlanned > 0
    ? ` (${progress.framesWritten} of ${progress.framesPlanned} frames written)`
    : "";
  const sentences = [
    `The output volume ran out of space during ${where}${frames}.`,
    `${progress.completedVariants.length} of ${progress.totalVariants} variant(s) finished; their final files remain in ${progress.recipeDirectory}.`,
    "manifest.json was not written for this run; a manifest from an earlier run was left unchanged and may not match files this run replaced.",
    `Removed ${details.removedTemporaryFiles} temporary file(s) this run had created; apart from the frames of finished variants, removed after their validated encode, no other file was deleted.`
  ];
  if (progress.variant && progress.framesDirectory && progress.framesWritten > 0) {
    sentences.push(`The frames written for "${progress.variant}" remain in ${progress.framesDirectory}.`);
  }
  sentences.push(
    `Free space now: ${details.freeBytes === undefined ? "unknown" : formatBytes(details.freeBytes)}; estimated peak for this render: ${formatBytes(details.peakBytes)}.`,
    `Cause: ${toErrorMessage(details.cause)}`
  );
  return sentences.join(" ");
}

export function diskFullError(details: Parameters<typeof describeDiskFull>[0]): StudioError {
  return new StudioError(
    "OUTPUT_DISK_FULL",
    describeDiskFull(details),
    "Free disk space (the partial frame folder named above is safe to delete if its frames are not needed), then rerun with --force to replace this run's files.",
    {cause: details.cause}
  );
}
