import {spawn} from "node:child_process";
import {StudioError} from "../shared/errors.js";
import {runExecutable} from "../validation/tools.js";
import type {ReviewItem} from "./review.js";

/**
 * Images the review page derives from a render's videos: a trail (the per-pixel maximum of every n-th frame, which
 * shows the whole path of what moves) and a timed frame sheet (the frame at each S seconds, captioned with its time).
 * The arithmetic is pure; `probeVideo` and `decodeVideo` read the video through ffprobe and FFmpeg, file protocol only.
 */

/** A side above this, or more frames than `MAX_FRAMES`, is refused before decoding. */
export const MAX_SIDE = 8192;
export const MAX_FRAMES = 36_000;
export const MAX_SHEET_CELLS = 48;
export const SHEET_CELL_WIDTH = 384;
export const SHEET_COLUMNS = 4;
const SHEET_PAD = 8;
const GLYPH_SCALE = 2;
const CAPTION_BAND = 7 * GLYPH_SCALE + 10;
const BACKGROUND = [0x0b, 0x0d, 0x12] as const;
const INK = [0xe8, 0xea, 0xee] as const;

export interface RgbImage {
  width: number;
  height: number;
  /** Packed RGB, row by row. */
  data: Uint8Array;
}

/** `into` becomes the per-channel maximum of itself and `frame`. */
export function maxInto(into: Uint8Array, frame: Uint8Array): void {
  for (let index = 0; index < into.length; index += 1) {
    const value = frame[index]!;
    if (value > into[index]!) into[index] = value;
  }
}

/** The trail of `frames`: the per-pixel maximum of frames 0, every, 2·every, … */
export function trailOf(frames: readonly Uint8Array[], every: number): Uint8Array {
  const trail = new Uint8Array(frames[0]!.length);
  frames.forEach((frame, index) => {
    if (index % every === 0) maxInto(trail, frame);
  });
  return trail;
}

/** The sheet's instants 0, S, 2S, … below the video's duration, each with the first frame at or after it. */
export function sheetFrames(frameCount: number, fps: number, seconds: number): {seconds: number; frame: number}[] {
  const duration = frameCount / fps;
  const cells: {seconds: number; frame: number}[] = [];
  for (let step = 0; step * seconds < duration - 1e-9; step += 1) {
    const at = step * seconds;
    cells.push({seconds: at, frame: Math.min(frameCount - 1, Math.max(0, Math.ceil(at * fps - 1e-6)))});
  }
  return cells;
}

/** The decimals S needs, at least one and at most three. */
export function secondsDecimals(seconds: number): number {
  for (let decimals = 1; decimals < 3; decimals += 1) {
    if (Math.abs(Number(seconds.toFixed(decimals)) - seconds) < 1e-9) return decimals;
  }
  return 3;
}

/** A cell's caption: `2.0 s`, `0.25 s`, with as many decimals as the sheet's step needs. */
export function secondsLabel(at: number, step: number): string {
  return `${at.toFixed(secondsDecimals(step))} s`;
}

/** An S that keeps a sheet of `duration` seconds within `MAX_SHEET_CELLS` cells, for the refusal's hint. */
export function sheetStepFor(duration: number): number {
  return Math.ceil((duration / MAX_SHEET_CELLS) * 10) / 10 || 0.1;
}

/** Downscales packed RGB with an area (box) filter to `width` wide, keeping the aspect; never upscales. */
export function boxDownscale(image: RgbImage, width: number): RgbImage {
  if (width >= image.width) return {width: image.width, height: image.height, data: Uint8Array.from(image.data)};
  const height = Math.max(1, Math.round((image.height * width) / image.width));
  const spans = (from: number, to: number) => {
    const scale = from / to;
    return Array.from({length: to}, (_, index) => {
      const start = index * scale;
      const end = (index + 1) * scale;
      const parts: [number, number][] = [];
      for (let source = Math.floor(start); source < Math.min(from, Math.ceil(end - 1e-9)); source += 1) {
        parts.push([source, (Math.min(end, source + 1) - Math.max(start, source)) / scale]);
      }
      return parts;
    });
  };
  const columns = spans(image.width, width);
  const rows = spans(image.height, height);
  const across = new Float64Array(width * image.height * 3);
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      for (const [source, weight] of columns[x]!) {
        for (let channel = 0; channel < 3; channel += 1) {
          across[(y * width + x) * 3 + channel]! += image.data[(y * image.width + source) * 3 + channel]! * weight;
        }
      }
    }
  }
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      for (let channel = 0; channel < 3; channel += 1) {
        let sum = 0;
        for (const [source, weight] of rows[y]!) sum += across[(source * width + x) * 3 + channel]! * weight;
        data[(y * width + x) * 3 + channel] = Math.min(255, Math.round(sum));
      }
    }
  }
  return {width, height, data};
}

/** A 5×7 bitmap font with what a sheet's captions use, drawn by this code: no system font, no `drawtext`. */
const GLYPHS: Record<string, readonly string[]> = {
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11111", "00010", "00100", "00010", "00001", "10001", "01110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
  ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
  s: ["00000", "00000", "01110", "10000", "01110", "00001", "11110"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"]
};

/** Draws `text` with the bitmap font, its top left at (x, y), each font pixel `scale` pixels wide; returns its width. */
export function drawText(image: RgbImage, x: number, y: number, text: string, scale: number, color: readonly number[] = INK): number {
  let left = x;
  for (const character of text) {
    const glyph = GLYPHS[character];
    if (!glyph) throw new RangeError(`The sheet font has no glyph for ${JSON.stringify(character)}.`);
    glyph.forEach((row, glyphY) => {
      [...row].forEach((bit, glyphX) => {
        if (bit !== "1") return;
        for (let dy = 0; dy < scale; dy += 1) {
          for (let dx = 0; dx < scale; dx += 1) {
            const px = left + glyphX * scale + dx;
            const py = y + glyphY * scale + dy;
            if (px < 0 || py < 0 || px >= image.width || py >= image.height) continue;
            image.data.set(color.slice(0, 3), (py * image.width + px) * 3);
          }
        }
      });
    });
    left += 6 * scale;
  }
  return left - x;
}

/** The sheet's size and grid for `cells` cells of a `width`×`height` video. */
export function sheetLayout(cells: number, width: number, height: number): {
  columns: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
  width: number;
  height: number;
} {
  const cellWidth = Math.min(SHEET_CELL_WIDTH, width);
  const cellHeight = cellWidth === width ? height : Math.max(1, Math.round((height * cellWidth) / width));
  const columns = Math.min(SHEET_COLUMNS, cells);
  const rows = Math.ceil(cells / columns);
  return {
    columns,
    rows,
    cellWidth,
    cellHeight,
    width: SHEET_PAD + columns * (cellWidth + SHEET_PAD),
    height: SHEET_PAD + rows * (cellHeight + CAPTION_BAND + SHEET_PAD)
  };
}

/** The timed frame sheet: each cell (already downscaled) in a grid on the dark background, its time below it. */
export function composeSheet(cells: readonly {image: RgbImage; label: string}[]): RgbImage {
  const first = cells[0]!.image;
  const layout = sheetLayout(cells.length, first.width, first.height);
  const sheet: RgbImage = {width: layout.width, height: layout.height, data: new Uint8Array(layout.width * layout.height * 3)};
  for (let index = 0; index < sheet.data.length; index += 3) sheet.data.set(BACKGROUND, index);
  cells.forEach((cell, index) => {
    const left = SHEET_PAD + (index % layout.columns) * (layout.cellWidth + SHEET_PAD);
    const top = SHEET_PAD + Math.floor(index / layout.columns) * (layout.cellHeight + CAPTION_BAND + SHEET_PAD);
    for (let y = 0; y < Math.min(cell.image.height, layout.cellHeight); y += 1) {
      const row = cell.image.data.subarray(y * cell.image.width * 3, (y * cell.image.width + Math.min(cell.image.width, layout.cellWidth)) * 3);
      sheet.data.set(row, ((top + y) * sheet.width + left) * 3);
    }
    drawText(sheet, left, top + layout.cellHeight + 5, cell.label, GLYPH_SCALE);
  });
  return sheet;
}

/** The highest number among a section's codes (`LT-07` → 7). */
export function highestReviewNumber(tag: string, items: readonly ReviewItem[]): number {
  let highest = 0;
  for (const item of items) {
    const number = Number(item.code.slice(tag.length + 1));
    if (item.code.startsWith(`${tag}-`) && Number.isInteger(number) && number > highest) highest = number;
  }
  return highest;
}

/**
 * The derived items of a section, numbered after its highest code: first a trail per video item, then a sheet per
 * video item, each in the order of the videos. `videos` are the section's video items that are on disk.
 */
export function reviewMediaItems(
  tag: string,
  items: readonly ReviewItem[],
  videos: readonly ReviewItem[],
  options: {trailEvery?: number; sheetSeconds?: number}
): ReviewItem[] {
  const derived: Omit<ReviewItem, "code">[] = [];
  if (options.trailEvery !== undefined) {
    for (const video of videos) derived.push({kind: "trail", file: video.file, ...variantOf(video), source: video.code, every: options.trailEvery});
  }
  if (options.sheetSeconds !== undefined) {
    for (const video of videos) derived.push({kind: "sheet", file: video.file, ...variantOf(video), source: video.code, step: options.sheetSeconds});
  }
  const highest = highestReviewNumber(tag, items);
  const width = Math.max(2, String(highest + derived.length).length);
  return derived.map((item, index) => ({code: `${tag}-${String(highest + 1 + index).padStart(width, "0")}`, ...item}));
}

function variantOf(item: ReviewItem): {variant?: string} {
  return item.variant === undefined ? {} : {variant: item.variant};
}

export interface VideoProbe {
  width: number;
  height: number;
  fps: number;
  frames: number;
}

/** The arguments that make FFmpeg and ffprobe read only this file: the file protocol, by absolute `file:` URL. */
export function fileInput(path: string): string[] {
  return ["-protocol_whitelist", "file", "-i", `file:${path}`];
}

function rate(value: unknown): number {
  const [numerator, denominator] = String(value ?? "").split("/").map(Number);
  const result = numerator! / (denominator ?? 1);
  return Number.isFinite(result) && result > 0 ? result : NaN;
}

/** Size, frame rate and frame count of a video's first stream, refused when out of bounds. */
export async function probeVideo(ffprobe: string, path: string): Promise<VideoProbe> {
  const probed = await runExecutable(
    ffprobe,
    ["-v", "error", ...fileInput(path), "-select_streams", "v:0", "-count_packets", "-show_entries", "stream=width,height,r_frame_rate,avg_frame_rate,nb_read_packets", "-of", "json"],
    {maxOutputBytes: 64_000}
  );
  if (probed.code !== 0) throw new StudioError("FFPROBE_FAILED", `ffprobe could not read ${path} (exit ${probed.code}): ${probed.stderr.slice(-2000)}`);
  let stream: Record<string, unknown> | undefined;
  try {
    stream = (JSON.parse(probed.stdout) as {streams?: Record<string, unknown>[]}).streams?.[0];
  } catch {
    stream = undefined;
  }
  const width = Number(stream?.width);
  const height = Number(stream?.height);
  const fps = rate(stream?.r_frame_rate) || rate(stream?.avg_frame_rate);
  const frames = Number(stream?.nb_read_packets);
  if (!stream || ![width, height, frames].every((value) => Number.isInteger(value) && value > 0) || !Number.isFinite(fps)) {
    throw new StudioError("REVIEW_MEDIA_INVALID", `${path} has no video stream with a size, frame rate, and frame count.`);
  }
  if (width > MAX_SIDE || height > MAX_SIDE || frames > MAX_FRAMES) {
    throw new StudioError(
      "REVIEW_MEDIA_TOO_LARGE",
      `${path} is ${width}x${height} with ${frames} frames; trails and sheets decode at most ${MAX_SIDE} px a side and ${MAX_FRAMES} frames.`,
      "Review a shorter or smaller render, or run review without --trails and --sheet."
    );
  }
  return {width, height, fps, frames};
}

/**
 * One decode pass over a video: the running maximum of every `trailEvery`-th frame, and a downscaled copy of each
 * frame `sheetIndexes` names. Frames stream from FFmpeg's raw RGB output; only the trail and the sheet's cells stay.
 */
export async function decodeVideo(options: {
  ffmpeg: string;
  path: string;
  probe: VideoProbe;
  trailEvery?: number;
  sheetIndexes?: readonly number[];
}): Promise<{trail?: RgbImage; cells: Map<number, RgbImage>; frames: number}> {
  const {width, height} = options.probe;
  const frameBytes = width * height * 3;
  const trail = options.trailEvery === undefined ? undefined : new Uint8Array(frameBytes);
  const wanted = new Set(options.sheetIndexes ?? []);
  const cells = new Map<number, RgbImage>();
  const frame = new Uint8Array(frameBytes);
  let filled = 0;
  let index = 0;
  let overflow = false;
  const child = spawn(
    options.ffmpeg,
    ["-v", "error", "-nostdin", ...fileInput(options.path), "-map", "0:v:0", "-an", "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    {shell: false, stdio: ["ignore", "pipe", "pipe"]}
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (text: string) => {
    if (stderr.length < 16_000) stderr += text;
  });
  const done = (data: Buffer) => {
    let offset = 0;
    while (offset < data.length && !overflow) {
      const take = Math.min(frameBytes - filled, data.length - offset);
      frame.set(data.subarray(offset, offset + take), filled);
      filled += take;
      offset += take;
      if (filled < frameBytes) break;
      if (trail && index % options.trailEvery! === 0) maxInto(trail, frame);
      if (wanted.has(index)) cells.set(index, boxDownscale({width, height, data: frame}, SHEET_CELL_WIDTH));
      index += 1;
      filled = 0;
      if (index > MAX_FRAMES) {
        overflow = true;
        child.kill("SIGKILL");
      }
    }
  };
  child.stdout.on("data", done);
  const code = await new Promise<number>((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("close", (exit) => resolvePromise(exit ?? 1));
  });
  if (overflow) throw new StudioError("REVIEW_MEDIA_TOO_LARGE", `${options.path} decodes to more than ${MAX_FRAMES} frames.`);
  if (code !== 0) throw new StudioError("FFMPEG_FAILED", `FFmpeg could not decode ${options.path} (exit ${code}): ${stderr.slice(-2000)}`);
  if (index === 0) throw new StudioError("REVIEW_MEDIA_INVALID", `FFmpeg decoded no frame of ${options.path}.`);
  return {...(trail ? {trail: {width, height, data: trail}} : {}), cells, frames: index};
}
