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
 * --period <ms> cuts at the widget's known period instead, for a widget that repeats exactly but not on even cycles
 * (a chat that sends one message every 1-2 s on a 12 s cycle), where the cut above finds uneven cycles. The loop
 * still ends at R and starts one period earlier, at S, where the picture must hold still for FADE frames. Every still
 * stretch keeps the compression error of its first frame, so S and R differ a little even with the same content: the
 * loop's first FADE frames blend from the original's own continuation (R onward) into S onward, so the wrap from the
 * loop's last frame to its first is two consecutive frames of the original. The video must end with FADE still frames.
 *
 * Studio video before 2026-09-29 was encoded with the BT.601 matrix and no color tags; newer video is BT.709 and
 * tagged. FFmpeg reads the input's tags and decodes an untagged video as BT.601, so either kind comes out as a
 * tagged BT.709 master. Never force in_color_matrix=bt601: it shifts the colors of a newer video.
 *
 * Next to each loop goes <video>-loop.json: the mode, the loop's first frame and length, where it was in the original,
 * how close S and R were, the encoder settings with the CRF, and both files' SHA-256.
 *
 * Usage: cut-loop.mjs [--period <ms>] <video.mp4> [...]   writes <video>-loop.mp4 and <video>-loop.json next to
 * each input; never replaces either. Needs ffmpeg and ffprobe on PATH. Exit code 1 when any input has no loop.
 */
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {basename, dirname, extname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const SMALL = [480, 270];  // motion is measured on a downscaled luma copy
export const STILL = 0.02; // mean |luma step| (0-255) at or below which a frame counts as unchanged
export const REST = 10;    // unchanged frames before a change for it to start a cycle
export const MATCH = 1.0;  // mean |luma difference| (full resolution) for S and R to count as the same picture
export const FADE = 8;     // --period: frames at the start of the loop that blend from R onward into S onward
// --period: mean |luma difference| for S and R. The same chat picture measured 0.85-1.7 on four iMessage chats
// encoded at x264's defaults (2026-10-08); a period that lands on another state measured 12 or more.
export const PERIOD_MATCH = 4.0;
export const ENCODING = {codec: 'h264', crf: 16, preset: 'slow'};
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

/**
 * Finds the loop of a known period, in frames, in a per-frame motion list (as for findLoop).
 * Returns {start, rest} with the loop as frames start..rest-1 and the blend from frames rest..rest+FADE-1, or {error}.
 */
export function findPeriodLoop(moved, period) {
  if (!Number.isInteger(period) || period <= FADE) {
    return {error: `the period must be a whole number of frames longer than the ${FADE}-frame blend, not ${period}`};
  }
  const count = moved.length;
  let rest = count;
  while (rest > 0 && !moved[rest - 1]) rest--;
  if (rest === 0) return {error: 'the video never changes'};
  if (count - rest < FADE) return {error: `the final rest from ${rest} is ${count - rest} frames; the blend needs ${FADE}`};
  const start = rest - period;
  if (start < 0) return {error: `the loop would start at ${start}, before the first frame`};
  const moving = moved.slice(start + 1, start + FADE).indexOf(true);
  if (moving !== -1) return {error: `frame ${start + 1 + moving} changes inside the blend frames ${start}..${start + FADE - 1}`};
  return {start, rest};
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

const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');

/**
 * Cuts one video; returns a one-line report that starts with LOOP, NO-LOOP, or FAILED.
 * With periodMs, cuts at that period (see --period above) instead of finding even cycles.
 */
export function cutLoop(input, {periodMs} = {}) {
  const path = resolve(input);
  const name = basename(path);
  const stem = join(dirname(path), `${basename(path, extname(path))}-loop`);
  const target = `${stem}.mp4`;
  const recordPath = `${stem}.json`;
  for (const file of [target, recordPath]) {
    if (existsSync(file)) return `FAILED ${name}: ${basename(file)} already exists; move it away first`;
  }
  const {width, height, fps, frames: inputFrames, color} = probe(path);
  let period;
  if (periodMs !== undefined) {
    period = periodMs * fps / 1000;
    if (Math.abs(period - Math.round(period)) > 0.01) {
      return `NO-LOOP ${name}: a period of ${periodMs} ms is ${period.toFixed(3)} frames at ${fps} fps, not a whole number`;
    }
    period = Math.round(period);
  }
  const [w, h] = SMALL;
  const small = luma(path, `scale=${w}:${h}:flags=area,format=gray`, w * h);
  const moved = small.map((frame, index) => index > 0 && meanDiff(frame, small[index - 1]) > STILL);
  const found = period === undefined ? findLoop(moved) : findPeriodLoop(moved, period);
  if (found.error) return `NO-LOOP ${name}: ${found.error}`;
  const {start, rest} = found;
  const limit = period === undefined ? MATCH : PERIOD_MATCH;
  const pair = luma(path, `select='eq(n\\,${start})+eq(n\\,${rest})',format=gray`, width * height);
  const match = meanDiff(pair[0], pair[1]);
  if (match > limit) return `NO-LOOP ${name}: frame ${start} and frame ${rest} differ (mean ${match.toFixed(3)})`;
  const frames = rest - start;
  const select = (first, last) => `select='between(n\\,${first}\\,${last})'`;
  // The blend pairs its inputs by timestamp, so both count frames from 0 at the video's rate; with PTS-STARTPTS the
  // tpad clones came out late and the loop ran past its length.
  const filter = period === undefined
    ? ['-vf', `${select(start, rest - 1)},setpts=PTS-STARTPTS,${TO_BT709}`]
    : ['-filter_complex', `[0]split[x][y];[x]${select(start, rest - 1)},setpts=N/FRAME_RATE/TB[a];`
      + `[y]${select(rest, rest + FADE - 1)},setpts=N/FRAME_RATE/TB,tpad=stop_mode=clone:stop=${frames - FADE}[b];`
      + `[a][b]blend=all_expr='A*min(N/${FADE}\\,1)+B*(1-min(N/${FADE}\\,1))',${TO_BT709}[out]`, '-map', '[out]'];
  run('ffmpeg', ['-v', 'error', '-n', '-i', path, ...filter, '-fps_mode', 'passthrough',
    '-c:v', 'libx264', '-preset', ENCODING.preset, '-crf', String(ENCODING.crf), '-movflags', '+faststart', '-an', target]);
  const written = probe(target);
  if (written.frames !== frames) return `FAILED ${basename(target)}: wrote ${written.frames} frames, expected ${frames}`;
  const shape = period === undefined
    ? {cycle: found.cycle, changes: found.changes}
    : {periodMs, blend: {frames: FADE, fromFrame: rest}};
  const record = {
    schemaVersion: 1,
    tool: 'se-widget-studio cut-loop.mjs',
    mode: period === undefined ? 'cycles' : 'period',
    input: {file: name, sha256: sha256(path), frames: inputFrames, fps, width, height, color},
    output: {file: basename(target), sha256: sha256(target), frames: written.frames, color: written.color},
    loop: {firstFrame: start, lastFrame: rest - 1, frames, durationMs: Number((frames * 1000 / fps).toFixed(3)),
      originalOffsetMs: Number((start * 1000 / fps).toFixed(3)), ...shape},
    match: {frames: [start, rest], mean: Number(match.toFixed(3)), limit},
    encoding: ENCODING
  };
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, {flag: 'wx'});
  const how = period === undefined
    ? `${found.changes.length} cycles of ${found.cycle}) -> ${basename(target)}; changes at [${found.changes}]`
    : `period of ${periodMs} ms) -> ${basename(target)}; blended from frames ${rest}..${rest + FADE - 1} over ${FADE} frames`;
  return `LOOP ${name}: frames ${start}..${rest - 1} (${frames} frames, ${(frames / fps).toFixed(3)} s, ${how}; `
    + `frame ${start} vs ${rest}: mean ${match.toFixed(3)}; color ${color} -> ${written.color}; `
    + `original t = loop t + ${(start / fps).toFixed(3)} s; crf ${ENCODING.crf}; record ${basename(recordPath)}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const inputs = process.argv.slice(2);
  if (!inputs.length || inputs.includes('--help')) {
    console.log('Usage: cut-loop.mjs [--period <ms>] <video.mp4> [...]\nCuts each Studio MP4 to an exact loop, written as <video>-loop.mp4 (tagged BT.709 H.264, CRF 16) with <video>-loop.json. --period cuts at the widget\'s known period, in milliseconds, instead of finding even cycles. Needs ffmpeg and ffprobe on PATH.');
    process.exit(inputs.length ? 0 : 2);
  }
  let periodMs;
  const flag = inputs.indexOf('--period');
  if (flag !== -1) {
    periodMs = Number(inputs[flag + 1]);
    if (!(periodMs > 0)) {
      console.error('--period takes the loop length in milliseconds, for example --period 12000.');
      process.exit(2);
    }
    inputs.splice(flag, 2);
  }
  let failed = false;
  for (const input of inputs) {
    let line;
    try {line = cutLoop(input, {periodMs});} catch (error) {line = `FAILED ${basename(input)}: ${error.message}`;}
    if (!line.startsWith('LOOP ')) failed = true;
    console.log(line);
  }
  process.exit(failed ? 1 : 0);
}
