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
 * --beat <frames>, with --period, cuts a widget that never holds still but changes on a fixed beat (a boiling line
 * redrawn every 4 frames), which has no still frames to blend. A beat is a frame that changes between two holds: the
 * picture is the same for the beat's length before it and from it, so nothing else is moving there (a message that
 * pops in on a beat would hide a skipped one). The loop starts on a beat (S) whose frame one period later (R) is a beat
 * too, so its last frame ends a whole hold, and it is cut without a blend: the wrap from R - 1 to S must change like
 * the original's own beats there, from S - 1 to S and from R - 1 to R, at least BEAT_FLOOR times the smaller (less is
 * a skipped beat) and at most BEAT_LIMIT times the larger. Of the starts that do not skip a beat, it takes the one
 * whose wrap changes least.
 *
 * Studio video before 2026-09-29 was encoded with the BT.601 matrix and no color tags; newer video is BT.709 and
 * tagged. FFmpeg reads the input's tags and decodes an untagged video as BT.601, so either kind comes out as a
 * tagged BT.709 master. Never force in_color_matrix=bt601: it shifts the colors of a newer video.
 *
 * Next to each loop goes <video>-loop.json: the mode, the loop's first frame and length, where it was in the original,
 * how close S and R were (with --beat, how much the wrap and the beats around it changed), the encoder settings with
 * the CRF, and both files' SHA-256.
 *
 * --check finds and measures the loop the same way and prints its LOOP or NO-LOOP line, but encodes and writes
 * nothing: check a period with it before the cut. Finding and measuring only decode. The encode is the heavy step: it
 * waits for the machine-wide render slot in the order of its queue, then for the machine check, as a local render does
 * (src/shared/render-slot.ts and src/shared/machine-check.ts, from the engine build next to this script or the live
 * checkout's), and gives the slot back as soon as ffmpeg ends. On 2026-10-28 a check of --period 11867 --beat 4,
 * expected to come out NO-LOOP, came out LOOP and encoded a 1080p cut outside the slot while mutation chains held
 * their turns in it (#21).
 *
 * Usage: cut-loop.mjs [--check] [--period <ms> [--beat <frames>]] <video.mp4> [...]   writes <video>-loop.mp4 and
 * <video>-loop.json next to each input, or with --check nothing; never replaces either. Needs ffmpeg and ffprobe on
 * PATH. Exit code 1 when any input has no loop.
 */
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {basename, dirname, extname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

import {engineBuilds} from './studio-client.mjs';

const SMALL = [480, 270];  // motion is measured on a downscaled luma copy
export const STILL = 0.02; // mean |luma step| (0-255) at or below which a frame counts as unchanged
export const REST = 10;    // unchanged frames before a change for it to start a cycle
export const MATCH = 1.0;  // mean |luma difference| (full resolution) for S and R to count as the same picture
export const FADE = 8;     // --period: frames at the start of the loop that blend from R onward into S onward
// --period: mean |luma difference| for S and R. The same chat picture measured 0.85-1.7 on four iMessage chats
// encoded at x264's defaults (2026-10-08); a period that lands on another state measured 12 or more.
export const PERIOD_MATCH = 4.0;
// --beat: how much the wrap may change against the beats around it. On se-crayon-chat's 2026-10-27 video (a boil
// redrawn every 4 frames), the wraps of a 12 s period measured 1.1-1.5 times the larger beat at full resolution; at
// 480 x 270, a period that skips a beat (356 frames) measured 0.26 of the smaller, one on another chat state (300) 8.5
// times the larger.
export const BEAT_FLOOR = 0.5;
export const BEAT_LIMIT = 2.0;
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

const skipsBeat = ({mean, beats}) => mean < BEAT_FLOOR * Math.min(...beats);

/** Why a wrap ({start, rest, mean, beats}) does not change like the beats around it, or undefined when it does. */
export function wrapError(wrap) {
  const {start, rest, mean, beats: [into, out]} = wrap;
  const said = `the wrap from frame ${rest - 1} to frame ${start} changes by ${mean.toFixed(3)}`;
  const around = `the beats around it (${into.toFixed(3)} and ${out.toFixed(3)})`;
  if (skipsBeat(wrap)) return `${said}, less than ${BEAT_FLOOR} of ${around}: the period skips a beat`;
  if (mean > BEAT_LIMIT * Math.max(into, out)) return `${said}, more than ${BEAT_LIMIT} times ${around}`;
  return undefined;
}

/**
 * Finds the loop of a known period on a known beat, both in frames, in a list of luma frames (see --beat above).
 * Returns {start, rest} with the loop as frames start..rest-1, or {error}.
 */
export function findBeatLoop(frames, period, beat) {
  if (!Number.isInteger(beat) || beat < 2) return {error: `the beat must be a whole number of frames, at least 2, not ${beat}`};
  if (!Number.isInteger(period) || period < beat || period % beat !== 0) {
    return {error: `the period must be a whole number of ${beat}-frame beats, not ${period} frames`};
  }
  const steps = frames.map((frame, index) => index > 0 ? meanDiff(frame, frames[index - 1]) : 0);
  const holds = (from, to) => steps.slice(from, to).every(step => step <= STILL);
  const onBeat = index => steps[index] > STILL && holds(index - beat + 1, index) && holds(index + 1, index + beat);
  const wraps = [];
  for (let start = beat; start + period + beat <= frames.length; start++) {
    const rest = start + period;
    if (onBeat(start) && onBeat(rest)) {
      wraps.push({start, rest, mean: meanDiff(frames[rest - 1], frames[start]), beats: [steps[start], steps[rest]]});
    }
  }
  if (!wraps.length) {
    return {error: `no beat (a change between two ${beat}-frame holds) has another one ${period} frames later`};
  }
  const beating = wraps.filter(wrap => !skipsBeat(wrap));
  const best = (beating.length ? beating : wraps).reduce((least, wrap) => wrap.mean < least.mean ? wrap : least);
  const error = wrapError(best);
  return error ? {error} : {start: best.start, rest: best.rest};
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

/** The render slot and the machine check of the engine build next to this script, else of the live checkout's. */
async function engine() {
  const builds = engineBuilds();
  for (const build of builds) {
    try {
      const modules = await Promise.all(['render-slot.js', 'machine-check.js'].map(file => import(pathToFileURL(resolve(build, 'shared', file)).href)));
      return Object.assign({}, ...modules);
    } catch {/* the next build */}
  }
  throw new Error(`the encode waits for the render slot, and no engine build was found at ${builds.join(' or ')}; run npm run build in the Studio checkout, or measure the loop with --check, which encodes nothing`);
}

/** Runs the encoding ffmpeg holding the render slot: in the order of its queue, then once the machine check says free. */
async function encode(args, command) {
  const {acquireRenderSlot, waitForMachine} = await engine();
  const log = message => process.stderr.write(`${message}\n`);
  const slot = await acquireRenderSlot({command, repo: 'se-dev-kit', log});
  try {
    // Under a slot inherited from a parent (RENDER_SLOT_HELD), the parent asked the machine check.
    if (!slot.inherited) await waitForMachine({log});
    run('ffmpeg', args);
  } finally {
    slot.release();
  }
}

/**
 * Cuts one video; resolves to a one-line report that starts with LOOP, NO-LOOP, or FAILED.
 * With periodMs, cuts at that period (see --period above) instead of finding even cycles; with beat too, at that
 * period on that beat (see --beat above). With check, only finds and measures the loop (see --check above).
 */
export async function cutLoop(input, {periodMs, beat, check = false} = {}) {
  if (beat !== undefined && periodMs === undefined) throw new Error('--beat needs --period');
  const mode = beat !== undefined ? 'beat' : periodMs !== undefined ? 'period' : 'cycles';
  const path = resolve(input);
  const name = basename(path);
  const stem = join(dirname(path), `${basename(path, extname(path))}-loop`);
  const target = `${stem}.mp4`;
  const recordPath = `${stem}.json`;
  for (const file of check ? [] : [target, recordPath]) {
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
  let found;
  if (mode === 'beat') found = findBeatLoop(small, period, beat);
  else {
    const moved = small.map((frame, index) => index > 0 && meanDiff(frame, small[index - 1]) > STILL);
    found = mode === 'cycles' ? findLoop(moved) : findPeriodLoop(moved, period);
  }
  if (found.error) return `NO-LOOP ${name}: ${found.error}`;
  const {start, rest} = found;
  const round = value => Number(value.toFixed(3));
  let match;
  let compared;
  if (mode === 'beat') {
    const at = [start - 1, start, rest - 1, rest];
    const [before, first, last, after] = luma(path, `select='${at.map(n => `eq(n\\,${n})`).join('+')}',format=gray`, width * height);
    const wrap = {start, rest, mean: meanDiff(last, first), beats: [meanDiff(before, first), meanDiff(last, after)]};
    const error = wrapError(wrap);
    if (error) return `NO-LOOP ${name}: ${error}`;
    const [into, out] = wrap.beats;
    match = {frames: [rest - 1, start], mean: round(wrap.mean), limit: round(BEAT_LIMIT * Math.max(into, out)),
      floor: round(BEAT_FLOOR * Math.min(into, out)),
      beats: [{frames: [start - 1, start], mean: round(into)}, {frames: [rest - 1, rest], mean: round(out)}]};
    compared = `wrap ${rest - 1} -> ${start}: mean ${wrap.mean.toFixed(3)} against beats of ${into.toFixed(3)} and ${out.toFixed(3)}`;
  } else {
    const limit = mode === 'cycles' ? MATCH : PERIOD_MATCH;
    const pair = luma(path, `select='eq(n\\,${start})+eq(n\\,${rest})',format=gray`, width * height);
    const mean = meanDiff(pair[0], pair[1]);
    if (mean > limit) return `NO-LOOP ${name}: frame ${start} and frame ${rest} differ (mean ${mean.toFixed(3)})`;
    match = {frames: [start, rest], mean: round(mean), limit};
    compared = `frame ${start} vs ${rest}: mean ${mean.toFixed(3)}`;
  }
  const frames = rest - start;
  const [how, detail] = mode === 'cycles'
    ? [`${found.changes.length} cycles of ${found.cycle}`, `changes at [${found.changes}]`]
    : mode === 'period'
      ? [`period of ${periodMs} ms`, `blended from frames ${rest}..${rest + FADE - 1} over ${FADE} frames`]
      : [`period of ${periodMs} ms on a ${beat}-frame beat`, 'cut without a blend'];
  const loop = `LOOP ${name}: frames ${start}..${rest - 1} (${frames} frames, ${(frames / fps).toFixed(3)} s, ${how})`;
  const offset = `original t = loop t + ${(start / fps).toFixed(3)} s`;
  if (check) return `${loop}; ${detail}; ${compared}; ${offset}; --check: nothing encoded or written`;
  const select = (first, last) => `select='between(n\\,${first}\\,${last})'`;
  // The blend pairs its inputs by timestamp, so both count frames from 0 at the video's rate; with PTS-STARTPTS the
  // tpad clones came out late and the loop ran past its length.
  const filter = mode !== 'period'
    ? ['-vf', `${select(start, rest - 1)},setpts=PTS-STARTPTS,${TO_BT709}`]
    : ['-filter_complex', `[0]split[x][y];[x]${select(start, rest - 1)},setpts=N/FRAME_RATE/TB[a];`
      + `[y]${select(rest, rest + FADE - 1)},setpts=N/FRAME_RATE/TB,tpad=stop_mode=clone:stop=${frames - FADE}[b];`
      + `[a][b]blend=all_expr='A*min(N/${FADE}\\,1)+B*(1-min(N/${FADE}\\,1))',${TO_BT709}[out]`, '-map', '[out]'];
  await encode(['-v', 'error', '-n', '-i', path, ...filter, '-fps_mode', 'passthrough',
    '-c:v', 'libx264', '-preset', ENCODING.preset, '-crf', String(ENCODING.crf), '-movflags', '+faststart', '-an', target],
  `cut-loop.mjs ${basename(target)}`);
  const written = probe(target);
  if (written.frames !== frames) return `FAILED ${basename(target)}: wrote ${written.frames} frames, expected ${frames}`;
  const shape = mode === 'cycles' ? {cycle: found.cycle, changes: found.changes}
    : mode === 'period' ? {periodMs, blend: {frames: FADE, fromFrame: rest}}
    : {periodMs, beat: {frames: beat}};
  const record = {
    schemaVersion: 1,
    tool: 'se-widget-studio cut-loop.mjs',
    mode,
    input: {file: name, sha256: sha256(path), frames: inputFrames, fps, width, height, color},
    output: {file: basename(target), sha256: sha256(target), frames: written.frames, color: written.color},
    loop: {firstFrame: start, lastFrame: rest - 1, frames, durationMs: round(frames * 1000 / fps),
      originalOffsetMs: round(start * 1000 / fps), ...shape},
    match,
    encoding: ENCODING
  };
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, {flag: 'wx'});
  return `${loop} -> ${basename(target)}; ${detail}; ${compared}; color ${color} -> ${written.color}; `
    + `${offset}; crf ${ENCODING.crf}; record ${basename(recordPath)}`;
}

// Node resolves symlinks for the ESM entry point, so import.meta.url is the real path while argv[1] keeps the linked
// path an installed skill is invoked through (~/.claude/skills/se-widget-studio). Compare real paths.
function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const inputs = process.argv.slice(2);
  const check = inputs.includes('--check');
  if (check) inputs.splice(inputs.indexOf('--check'), 1);
  if (!inputs.length || inputs.includes('--help')) {
    console.log('Usage: cut-loop.mjs [--check] [--period <ms> [--beat <frames>]] <video.mp4> [...]\nCuts each Studio MP4 to an exact loop, written as <video>-loop.mp4 (tagged BT.709 H.264, CRF 16) with <video>-loop.json; the encode waits for its turn in the render slot. --check finds and measures the loop and prints LOOP or NO-LOOP, but encodes and writes nothing: check a period with it first. --period cuts at the widget\'s known period, in milliseconds, instead of finding even cycles. --beat, with --period, cuts a widget that never holds still on its beat, the frames from one of its changes to the next. Needs ffmpeg and ffprobe on PATH.');
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
  let beat;
  const beatFlag = inputs.indexOf('--beat');
  if (beatFlag !== -1) {
    beat = Number(inputs[beatFlag + 1]);
    if (!Number.isInteger(beat) || beat < 2 || periodMs === undefined) {
      console.error('--beat takes the frames from one change of the widget to the next, for example --beat 4, and needs --period.');
      process.exit(2);
    }
    inputs.splice(beatFlag, 2);
  }
  let failed = false;
  for (const input of inputs) {
    let line;
    try {line = await cutLoop(input, {periodMs, beat, check});} catch (error) {line = `FAILED ${basename(input)}: ${error.message}`;}
    if (!line.startsWith('LOOP ')) failed = true;
    console.log(line);
  }
  process.exit(failed ? 1 : 0);
}
