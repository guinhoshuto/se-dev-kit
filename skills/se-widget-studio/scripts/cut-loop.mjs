#!/usr/bin/env node
/**
 * Cuts a Studio MP4 to an exact loop and re-encodes it as a tagged BT.709 H.264 master.
 *
 * A Studio job keeps no PNG frames, so this works from the MP4 itself. It fits a widget that repeats a change on a
 * timer (a gallery, a rotating card, an alert queue): each cycle is a change, then a rest. The first rest is often
 * longer than the others (the widget waits a full interval before its first change), so the loop does not start at
 * frame 0: it ends where the last change settles (R, the first frame of the final rest) and starts a whole number
 * of cycles earlier (S), inside the first rest, where the picture must match R. Every state then rests for the
 * same time. The recipe's video must end at rest: make it last past a change by more than the change itself.
 *
 * Studio video before 2026-09-29 was encoded with the BT.601 matrix and no color tags; newer video is BT.709 and
 * tagged. FFmpeg reads the input's tags and decodes an untagged video as BT.601, so either kind comes out as a
 * tagged BT.709 master. Never force in_color_matrix=bt601: it shifts the colors of a newer video.
 *
 * Usage: cut-loop.mjs <video.mp4> [...]   writes <video>-loop.mp4 next to each input; never replaces one.
 * Needs ffmpeg and ffprobe on PATH. Exit code 1 when any input has no loop.
 */
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {basename, dirname, extname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const SMALL = [480, 270];  // motion is measured on a downscaled luma copy
export const STILL = 0.02; // mean |luma step| (0-255) at or below which a frame counts as unchanged
export const REST = 10;    // unchanged frames before a change for it to start a cycle
export const MATCH = 1.0;  // mean |luma difference| (full resolution) for S and R to count as the same picture
const TO_BT709 = 'scale=in_color_matrix=auto:in_range=auto,format=gbrp,'
  + 'scale=out_color_matrix=bt709:out_range=limited,format=yuv420p,'
  + 'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=limited';

export function meanDiff(a, b) {
  let sum = 0;
  for (let index = 0; index < a.length; index++) sum += Math.abs(a[index] - b[index]);
  return sum / a.length;
}

/**
 * Finds the loop in a per-frame motion list (moved[i]: frame i differs from frame i - 1).
 * Returns {start, rest, cycle, changes} with the loop as frames start..rest-1, or {error}.
 */
export function findLoop(moved) {
  const count = moved.length;
  const onsets = [];
  for (let index = REST; index < count; index++) {
    if (moved[index] && !moved.slice(index - REST, index).some(Boolean)) onsets.push(index);
  }
  let rest = count;
  while (rest > 0 && !moved[rest - 1]) rest--;
  if (rest === count || onsets.length < 2) {
    return {error: `no final rest or fewer than two changes (changes at [${onsets}], final rest from ${rest})`};
  }
  const gaps = onsets.slice(1).map((onset, index) => onset - onsets[index]);
  if (Math.max(...gaps) - Math.min(...gaps) > 1) return {error: `uneven cycles [${gaps}]`};
  const sorted = [...gaps].sort((a, b) => a - b);
  const cycle = Math.round((sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2);
  const changes = onsets.filter(onset => onset < rest);
  const start = rest - changes.length * cycle;
  if (start < 0 || start >= onsets[0]) {
    return {error: `loop start ${start} is outside the first rest (first change at ${onsets[0]})`};
  }
  return {start, rest, cycle, changes};
}

function run(command, args) {
  const result = spawnSync(command, args, {maxBuffer: 2 ** 31 - 1});
  if (result.error?.code === 'ENOENT') throw new Error(`${command} was not found on PATH.`);
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr.toString().trim()}`);
  return result.stdout;
}

export function probe(path) {
  const out = run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries',
    'stream=width,height,r_frame_rate,nb_read_frames,color_space', '-of', 'json', path]);
  const stream = JSON.parse(out.toString()).streams[0];
  const [numerator, denominator] = stream.r_frame_rate.split('/').map(Number);
  return {width: stream.width, height: stream.height, fps: numerator / denominator,
    frames: Number(stream.nb_read_frames), color: stream.color_space ?? 'unknown'};
}

function luma(path, filter, size) {
  const raw = run('ffmpeg', ['-v', 'error', '-i', path, '-vf', filter, '-fps_mode', 'passthrough', '-f', 'rawvideo', '-']);
  const frames = [];
  for (let offset = 0; offset + size <= raw.length; offset += size) frames.push(raw.subarray(offset, offset + size));
  return frames;
}

/** Cuts one video; returns a one-line report that starts with LOOP, NO-LOOP, or FAILED. */
export function cutLoop(input) {
  const path = resolve(input);
  const name = basename(path);
  const target = join(dirname(path), `${basename(path, extname(path))}-loop.mp4`);
  if (existsSync(target)) return `FAILED ${name}: ${basename(target)} already exists; move it away first`;
  const {width, height, fps, color} = probe(path);
  const [w, h] = SMALL;
  const small = luma(path, `scale=${w}:${h}:flags=area,format=gray`, w * h);
  const moved = small.map((frame, index) => index > 0 && meanDiff(frame, small[index - 1]) > STILL);
  const found = findLoop(moved);
  if (found.error) return `NO-LOOP ${name}: ${found.error}`;
  const {start, rest, cycle, changes} = found;
  const pair = luma(path, `select='eq(n\\,${start})+eq(n\\,${rest})',format=gray`, width * height);
  const match = meanDiff(pair[0], pair[1]);
  if (match > MATCH) return `NO-LOOP ${name}: frame ${start} and frame ${rest} differ (mean ${match.toFixed(3)})`;
  const frames = rest - start;
  run('ffmpeg', ['-v', 'error', '-n', '-i', path, '-vf',
    `select='between(n\\,${start}\\,${rest - 1})',setpts=PTS-STARTPTS,${TO_BT709}`, '-fps_mode', 'passthrough',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-movflags', '+faststart', '-an', target]);
  const written = probe(target);
  if (written.frames !== frames) return `FAILED ${basename(target)}: wrote ${written.frames} frames, expected ${frames}`;
  return `LOOP ${name}: frames ${start}..${rest - 1} (${frames} frames, ${(frames / fps).toFixed(3)} s, `
    + `${changes.length} cycles of ${cycle}) -> ${basename(target)}; changes at [${changes}]; `
    + `frame ${start} vs ${rest}: mean ${match.toFixed(3)}; color ${color} -> ${written.color}; `
    + `original t = loop t + ${(start / fps).toFixed(3)} s`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const inputs = process.argv.slice(2);
  if (!inputs.length || inputs.includes('--help')) {
    console.log('Usage: cut-loop.mjs <video.mp4> [...]\nCuts each Studio MP4 to an exact loop, written as <video>-loop.mp4 (tagged BT.709 H.264). Needs ffmpeg and ffprobe on PATH.');
    process.exit(inputs.length ? 0 : 2);
  }
  let failed = false;
  for (const input of inputs) {
    let line;
    try {line = cutLoop(input);} catch (error) {line = `FAILED ${basename(input)}: ${error.message}`;}
    if (!line.startsWith('LOOP ')) failed = true;
    console.log(line);
  }
  process.exit(failed ? 1 : 0);
}
