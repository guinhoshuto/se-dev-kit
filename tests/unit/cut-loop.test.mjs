import assert from "node:assert/strict";
import {execFile, spawn} from "node:child_process";
import {createHash} from "node:crypto";
import {once} from "node:events";
import {existsSync, mkdtempSync, rmSync} from "node:fs";
import {mkdtemp, readdir, readFile, rm, stat, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as sleep} from "node:timers/promises";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import test, {after} from "node:test";

import {cutLoop, findBeatLoop, findLoop, findPeriodLoop, wrapError} from "../../skills/se-widget-studio/scripts/cut-loop.mjs";
import {detectMediaTooling} from "../../dist/capture/media.js";
import {RENDER_SLOT} from "./ceding-chain.mjs";

const execFileAsync = promisify(execFile);
const SCRIPT = fileURLToPath(new URL("../../skills/se-widget-studio/scripts/cut-loop.mjs", import.meta.url));
const SKILL = fileURLToPath(new URL("../../skills/se-widget-studio", import.meta.url));
// Detected before the first test: a test declared after a top-level await is lost under --test-force-exit.
const tooling = await detectMediaTooling();
// A cut encodes in the render slot: this file's own, with no machine check, so no test waits in the machine-wide
// queue (npm test gives each suite its own slot; npm run mutate and node --test do not).
const SLOT_ROOT = mkdtempSync(join(tmpdir(), "sws-cut-loop-slot-"));
Object.assign(process.env, {RENDER_SLOT_DIR: join(SLOT_ROOT, "render-slot"), MACHINE_CHECK: join(SLOT_ROOT, "no-machine-check")});
after(() => rmSync(SLOT_ROOT, {recursive: true, force: true}));

/** A motion list: true on every frame of each change, which lasts `length` frames. */
function motion(count, changes, length = 5) {
  const moved = new Array(count).fill(false);
  for (const onset of changes) for (let index = onset; index < onset + length && index < count; index++) moved[index] = true;
  return moved;
}

/** A boil's four drawings, as levels over the picture: one every 4 frames, so the cycle repeats every 16. */
const BOIL = [0, 16, 6, 26];

/**
 * Levels of a 92-frame video that never holds still: a chat that rests on 40, moves to 120 at 20, to 200 at 40 and
 * back to 40 at 60 (see changeLevels), under the boil, whose redraw at frame 72 repeats its drawing.
 */
function boilLevels() {
  return changeLevels(92, 40, [[20, 120], [40, 200], [60, 40]])
    .map((level, index) => level + (index >= 72 && index < 76 ? BOIL[1] : BOIL[Math.floor(index / 4) % 4]));
}

/** The script as an installed skill runs it: through a link to the skill folder, as ~/.claude/skills/se-widget-studio is. */
async function linkedScript(root) {
  await symlink(SKILL, join(root, "se-widget-studio"), "dir");
  return join(root, "se-widget-studio", "scripts", "cut-loop.mjs");
}

test("cut-loop run through a link to the skill folder prints its usage", async () => {
  const root = await mkdtemp(join(tmpdir(), "sws-cut-loop-link-"));
  try {
    const {stdout} = await execFileAsync(process.execPath, [await linkedScript(root), "--help"]);
    assert.match(stdout, /^Usage: cut-loop\.mjs \[--check\] \[--period <ms> \[--beat <frames>\]\] <video\.mp4> \[\.\.\.\]\n/);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("findLoop ends the loop where the last change settles and starts it whole cycles earlier, inside the first rest", () => {
  assert.deepEqual(findLoop(motion(100, [30, 50, 70])), {start: 15, rest: 75, cycle: 20, changes: [30, 50, 70]});
  // A change that has not settled when the video ends is not part of the loop.
  assert.deepEqual(findLoop(motion(100, [30, 50, 70, 90], 10)).error, "no final rest or fewer than two changes (changes at [30,50,70,90], final rest from 100)");
});

test("findLoop refuses a video without a loop", () => {
  assert.match(findLoop(motion(100, [30])).error, /fewer than two changes/);
  assert.match(findLoop(motion(100, [20, 40, 63])).error, /uneven cycles \[20,23\]/);
  // Cycles one frame apart are rounding, not uneven.
  assert.equal(findLoop(motion(100, [20, 40, 61])).error, undefined);
  // The first rest is shorter than the start the cycles need.
  assert.match(findLoop(motion(100, [12, 32, 52])).error, /loop start -3 is outside the first rest \(first change at 12\)/);
  // Motion after fewer than 10 still frames continues the previous change instead of starting a cycle.
  const bounce = motion(100, [30, 50, 70]);
  bounce[57] = true;
  assert.deepEqual(findLoop(bounce).changes, [30, 50, 70]);
});

test("findPeriodLoop ends the loop where the last change settles and starts it one period earlier, on 8 still frames", () => {
  // Changes 4 frames long; the last one settles at 153, so the final rest starts at 154.
  const chat = (count) => motion(count, [5, 40, 52, 70, 120, 132, 150], 4);
  assert.deepEqual(findPeriodLoop(chat(200), 110), {start: 44, rest: 154});
  // The loop may start on the frame where a change settles: the 8 blend frames from there are the same picture.
  assert.deepEqual(findPeriodLoop(chat(200), 111), {start: 43, rest: 154});
  // The change at 52 is the eighth blend frame of a loop that starts at 45.
  assert.equal(findPeriodLoop(chat(200), 109).error, "frame 52 changes inside the blend frames 45..52");
  assert.equal(findPeriodLoop(chat(200), 160).error, "the loop would start at -6, before the first frame");
  // The blend reads 8 frames of the final rest.
  assert.deepEqual(findPeriodLoop(chat(162), 110), {start: 44, rest: 154});
  assert.equal(findPeriodLoop(chat(161), 110).error, "the final rest from 154 is 7 frames; the blend needs 8");
  assert.equal(findPeriodLoop(chat(154), 110).error, "the final rest from 154 is 0 frames; the blend needs 8");
  assert.equal(findPeriodLoop(new Array(50).fill(false), 20).error, "the video never changes");
  assert.equal(findPeriodLoop(chat(200), 8).error, "the period must be a whole number of frames longer than the 8-frame blend, not 8");
  assert.equal(findPeriodLoop(chat(200), 110.5).error, "the period must be a whole number of frames longer than the 8-frame blend, not 110.5");
});

test("findBeatLoop starts the loop on a beat one period before another, at the wrap that changes least without skipping a beat", () => {
  const frames = boilLevels().map((level) => [level]);
  // Beats at 4, 8, 12 and 16 have one 72 frames later. The wrap from 75 to 4 repeats a drawing, so it skips a beat;
  // of the others, 87 to 16 changes least (16 levels, against 20 for 79 to 8 and 26 for 83 to 12).
  assert.deepEqual(findBeatLoop(frames, 72, 4), {start: 16, rest: 88});
  assert.equal(findBeatLoop(frames, 84, 4).error, "the wrap from frame 87 to frame 4 changes by 0.000, less than 0.5 of the beats around it (16.000 and 10.000): the period skips a beat");
  // A period that lands on another picture: frame 35 rests on 120, frame 12 on 40.
  assert.equal(findBeatLoop(frames, 24, 4).error, "the wrap from frame 35 to frame 12 changes by 54.000, more than 2 times the beats around it (20.000 and 16.000)");
  assert.equal(findBeatLoop(frames, 88, 4).error, "no beat (a change between two 4-frame holds) has another one 88 frames later");
  assert.equal(findBeatLoop(frames, 75, 4).error, "the period must be a whole number of 4-frame beats, not 75 frames");
  assert.equal(findBeatLoop(frames, 72, 1).error, "the beat must be a whole number of frames, at least 2, not 1");
  // The same video has no still stretch for --period to blend.
  assert.equal(findPeriodLoop(frames.map(([level], index) => index > 0 && level !== frames[index - 1][0]), 72).error, "the final rest from 89 is 3 frames; the blend needs 8");
});

test("findBeatLoop counts a change as a beat only between two holds, so a change that starts on a beat cannot hide a skipped one", () => {
  // The chat pops from 40 to 120 and back on frames 40 to 52, under the boil. 36 frames are 9 beats, so every wrap
  // repeats a drawing of the boil. From frame 75 to frame 40, where the pop starts on a beat, the pop's own step would
  // pass for a beat; frame 40 does not hold, and neither does 44, where the pop settles at 120.
  const frames = changeLevels(100, 40, [[40, 120], [48, 40]]).map((level, index) => [level + BOIL[Math.floor(index / 4) % 4]]);
  assert.equal(findBeatLoop(frames, 36, 4).error, "the wrap from frame 55 to frame 20 changes by 0.000, less than 0.5 of the beats around it (16.000 and 10.000): the period skips a beat");
});

test("wrapError takes a wrap between half the smaller beat around it and twice the larger", () => {
  const wrap = (mean) => wrapError({start: 10, rest: 30, mean, beats: [4, 10]});
  assert.equal(wrap(2), undefined);
  assert.equal(wrap(20), undefined);
  assert.equal(wrap(1.999), "the wrap from frame 29 to frame 10 changes by 1.999, less than 0.5 of the beats around it (4.000 and 10.000): the period skips a beat");
  assert.equal(wrap(20.001), "the wrap from frame 29 to frame 10 changes by 20.001, more than 2 times the beats around it (4.000 and 10.000)");
});

/** Encodes one flat gray 64 x 36 frame per level at 30 FPS, nearly lossless. */
async function grayVideo(path, levels) {
  const [width, height] = [64, 36];
  await new Promise((done, fail) => {
    const ffmpeg = spawn(tooling.ffmpegPath, ["-v", "error", "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${width}x${height}`, "-r", "30", "-i", "-",
      "-c:v", "libx264", "-crf", "10", "-pix_fmt", "yuv420p", path]);
    ffmpeg.on("error", fail);
    ffmpeg.on("close", (code) => code === 0 ? done() : fail(new Error(`ffmpeg exited ${code}`)));
    ffmpeg.stdin.end(Buffer.concat(levels.map((level) => Buffer.alloc(width * height, level))));
  });
}

/** Levels of a video that rests on `first`, then moves into each [onset, level] over 5 frames. */
function changeLevels(count, first, changes) {
  const levels = [];
  let level = first;
  let from = first;
  for (let index = 0; index < count; index++) {
    const change = changes.find(([onset]) => index >= onset && index < onset + 5);
    if (change) level = Math.round(from + (change[1] - from) * (index - change[0] + 1) / 5);
    else from = level;
    levels.push(level);
  }
  return levels;
}

async function meanLuma(path, frame) {
  const {stdout} = await execFileAsync(tooling.ffmpegPath, ["-v", "error", "-i", path, "-vf", `select=eq(n\\,${frame}),format=gray`, "-frames:v", "1", "-f", "rawvideo", "-"], {encoding: "buffer"});
  return stdout.reduce((sum, value) => sum + value, 0) / stdout.length;
}

async function videoStream(path) {
  const {stdout} = await execFileAsync(tooling.ffprobePath, ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries",
    "stream=nb_read_frames,color_space,color_primaries,color_transfer,color_range", "-of", "json", path]);
  return {...JSON.parse(stdout).streams[0]};
}

/** The CRF x264 wrote into its settings message in the stream, e.g. "16.0". */
async function x264Crf(path) {
  return (await readFile(path)).toString("latin1").match(/x264 - core [^\0]*?\bcrf=(\d+\.\d+)/)?.[1];
}

const sha256 = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");
const media = {skip: tooling.ffmpegPath && tooling.ffprobePath ? false : "NOT COVERED: ffmpeg and ffprobe are missing"};

test("cut-loop writes the loop as a tagged BT.709 MP4 whose first frame is the picture after the last change", media, async () => {
  const root = await mkdtemp(join(tmpdir(), "sws-cut-loop-"));
  try {
    // Three flat states, a 5-frame blend into the next one at 30, 50 and 70, then rest to frame 100.
    const input = join(root, "listing.mp4");
    await grayVideo(input, changeLevels(100, 40, [[30, 120], [50, 200], [70, 40]]));

    assert.match(await cutLoop(input), /^LOOP listing\.mp4: frames 15\.\.74 \(60 frames, 2\.000 s, 3 cycles of 20\) -> listing-loop\.mp4;/);
    // The slot goes back with the encode, before the next input is measured.
    assert.equal(existsSync(process.env.RENDER_SLOT_DIR), false, "the cut kept the render slot after its encode");
    const output = join(root, "listing-loop.mp4");
    assert.deepEqual(await videoStream(output), {color_range: "tv", color_space: "bt709", color_transfer: "bt709", color_primaries: "bt709", nb_read_frames: "60"});
    const mean = await meanLuma(output, 0);
    assert.ok(Math.abs(mean - 40) <= 2, `the loop starts on the first state, mean luma ${mean}`);
    assert.equal(await x264Crf(output), "16.0");

    // The record next to the loop: where it starts in the original, and the CRF it was encoded at.
    const record = JSON.parse(await readFile(join(root, "listing-loop.json"), "utf8"));
    assert.equal(record.mode, "cycles");
    assert.deepEqual(record.loop, {firstFrame: 15, lastFrame: 74, frames: 60, durationMs: 2000, originalOffsetMs: 500, cycle: 20, changes: [30, 50, 70]});
    assert.deepEqual(record.encoding, {codec: "h264", crf: 16, preset: "slow"});
    assert.deepEqual([record.input.file, record.input.frames, record.input.fps], ["listing.mp4", 100, 30]);
    assert.equal(record.input.sha256, await sha256(input));
    assert.deepEqual([record.output.file, record.output.frames, record.output.color], ["listing-loop.mp4", 60, "bt709"]);
    assert.equal(record.output.sha256, await sha256(output));
    assert.deepEqual(record.match.frames, [15, 75]);

    // An existing loop or record is never replaced.
    await writeFile(output, "keep");
    assert.equal(await cutLoop(input), "FAILED listing.mp4: listing-loop.mp4 already exists; move it away first");
    await rm(output);
    assert.equal(await cutLoop(input), "FAILED listing.mp4: listing-loop.json already exists; move it away first");
    assert.equal(await readFile(join(root, "listing-loop.json"), "utf8"), `${JSON.stringify(record, null, 2)}\n`);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("cut-loop run through a link to the skill folder writes the loop", media, async () => {
  const root = await mkdtemp(join(tmpdir(), "sws-cut-loop-link-"));
  try {
    const input = join(root, "listing.mp4");
    await grayVideo(input, changeLevels(100, 40, [[30, 120], [50, 200], [70, 40]]));
    const {stdout} = await execFileAsync(process.execPath, [await linkedScript(root), input]);
    assert.match(stdout, /^LOOP listing\.mp4: frames 15\.\.74 \(60 frames, 2\.000 s, 3 cycles of 20\) -> listing-loop\.mp4;/);
    assert.ok((await stat(join(root, "listing-loop.mp4"))).size > 0);
    assert.equal(JSON.parse(await readFile(join(root, "listing-loop.json"), "utf8")).loop.frames, 60);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("cut-loop --period cuts a video that repeats on uneven changes, blending the loop's start from the original's continuation", media, async () => {
  const root = await mkdtemp(join(tmpdir(), "sws-cut-loop-period-"));
  try {
    // A 60-frame cycle whose changes come 15, 25 and 20 frames apart, twice. The final rest is 3 levels brighter than
    // the same picture in the first rest, as compression leaves each still stretch with the error of its first frame.
    const input = join(root, "chat.mp4");
    await grayVideo(input, changeLevels(180, 40, [[30, 120], [45, 200], [70, 40], [90, 120], [105, 200], [130, 43]]));
    assert.equal(await cutLoop(input), "NO-LOOP chat.mp4: uneven cycles [15,25,20,15,25]");
    assert.equal(await cutLoop(input, {periodMs: 2010}), "NO-LOOP chat.mp4: a period of 2010 ms is 60.300 frames at 30 fps, not a whole number");
    // A period that lands on another picture: frame 60 rests on 200.
    assert.match(await cutLoop(input, {periodMs: 2500}), /^NO-LOOP chat\.mp4: frame 60 and frame 135 differ \(mean 15\d\.\d{3}\)$/);

    const cli = await execFileAsync(process.execPath, [SCRIPT, "--period", "2000", input]);
    assert.match(cli.stdout, /^LOOP chat\.mp4: frames 75\.\.134 \(60 frames, 2\.000 s, period of 2000 ms\) -> chat-loop\.mp4; blended from frames 135\.\.142 over 8 frames;/);
    const output = join(root, "chat-loop.mp4");
    assert.deepEqual(await videoStream(output), {color_range: "tv", color_space: "bt709", color_transfer: "bt709", color_primaries: "bt709", nb_read_frames: "60"});
    assert.equal(await x264Crf(output), "16.0");
    // The loop opens on the original's continuation (frame 135, 43) and reaches the first rest (40) after 8 frames, so
    // the wrap from its last frame (frame 134, 43) to its first is two consecutive frames of the original.
    const [opening, settled, last] = [await meanLuma(output, 0), await meanLuma(output, 8), await meanLuma(output, 59)];
    assert.ok(Math.abs(opening - 43) <= 1, `the first frame is the continuation, mean luma ${opening}`);
    assert.ok(Math.abs(settled - 40) <= 1, `the ninth frame is the first rest, mean luma ${settled}`);
    assert.ok(Math.abs(last - opening) <= 1, `the wrap has no jump: ${last} to ${opening}`);

    const record = JSON.parse(await readFile(join(root, "chat-loop.json"), "utf8"));
    assert.equal(record.mode, "period");
    assert.deepEqual(record.loop, {firstFrame: 75, lastFrame: 134, frames: 60, durationMs: 2000, originalOffsetMs: 2500, periodMs: 2000, blend: {frames: 8, fromFrame: 135}});
    assert.deepEqual(record.encoding, {codec: "h264", crf: 16, preset: "slow"});
    assert.equal(record.input.sha256, await sha256(input));
    assert.equal(record.output.sha256, await sha256(output));
    assert.deepEqual(record.match.frames, [75, 135]);
    assert.ok(record.match.mean >= 2 && record.match.mean <= 4, `frame 75 and frame 135 differ by the 3 levels of the final rest: ${record.match.mean}`);

    await assert.rejects(execFileAsync(process.execPath, [SCRIPT, "--period", "twelve", input]), (error) => error.code === 2
      && error.stderr.includes("--period takes the loop length in milliseconds"));
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("cut-loop --period --beat cuts a video that never holds still on its beat, with a wrap that changes like one of its beats", media, async () => {
  const root = await mkdtemp(join(tmpdir(), "sws-cut-loop-beat-"));
  try {
    const input = join(root, "boil.mp4");
    await grayVideo(input, boilLevels());
    await assert.rejects(cutLoop(input, {beat: 4}), /^Error: --beat needs --period$/);
    // The boil never rests for the blend --period needs.
    assert.equal(await cutLoop(input, {periodMs: 2400}), "NO-LOOP boil.mp4: the final rest from 89 is 3 frames; the blend needs 8");
    assert.equal(await cutLoop(input, {periodMs: 2500, beat: 4}), "NO-LOOP boil.mp4: the period must be a whole number of 4-frame beats, not 75 frames");
    assert.match(await cutLoop(input, {periodMs: 800, beat: 4}), /^NO-LOOP boil\.mp4: the wrap from frame 35 to frame 12 changes by 5\d\.\d{3}, more than 2 times the beats around it \(/);

    // --check measures the same cut and writes nothing.
    const checked = await execFileAsync(process.execPath, [SCRIPT, "--check", "--period", "2400", "--beat", "4", input]);
    assert.match(checked.stdout, /^LOOP boil\.mp4: frames 16\.\.87 \(72 frames, 2\.400 s, period of 2400 ms on a 4-frame beat\); cut without a blend; wrap 87 -> 16: mean 1\d\.\d{3} against beats of 2\d\.\d{3} and \d+\.\d{3}; original t = loop t \+ 0\.533 s; --check: nothing encoded or written\n$/);
    assert.deepEqual(await readdir(root), ["boil.mp4"]);

    const cli = await execFileAsync(process.execPath, [SCRIPT, "--period", "2400", "--beat", "4", input]);
    assert.match(cli.stdout, /^LOOP boil\.mp4: frames 16\.\.87 \(72 frames, 2\.400 s, period of 2400 ms on a 4-frame beat\) -> boil-loop\.mp4; cut without a blend; wrap 87 -> 16: mean 1\d\.\d{3} against beats of 2\d\.\d{3} and \d+\.\d{3};/);
    const output = join(root, "boil-loop.mp4");
    assert.deepEqual(await videoStream(output), {color_range: "tv", color_space: "bt709", color_transfer: "bt709", color_primaries: "bt709", nb_read_frames: "72"});
    assert.equal(await x264Crf(output), "16.0");
    // The loop opens on frame 16 (40) and closes on frame 87 (56), so its wrap is one more beat of the boil.
    const [first, last] = [await meanLuma(output, 0), await meanLuma(output, 71)];
    assert.ok(Math.abs(first - 40) <= 2, `the first frame is frame 16, mean luma ${first}`);
    assert.ok(Math.abs(last - 56) <= 2, `the last frame is frame 87, mean luma ${last}`);

    const record = JSON.parse(await readFile(join(root, "boil-loop.json"), "utf8"));
    // A check after the cut measures again, next to the loop it never replaces.
    assert.match(await cutLoop(input, {periodMs: 2400, beat: 4, check: true}), /^LOOP boil\.mp4: frames 16\.\.87 .*; --check: nothing encoded or written$/);
    assert.equal(record.mode, "beat");
    assert.deepEqual(record.loop, {firstFrame: 16, lastFrame: 87, frames: 72, durationMs: 2400, originalOffsetMs: 533.333, periodMs: 2400, beat: {frames: 4}});
    assert.deepEqual(record.encoding, {codec: "h264", crf: 16, preset: "slow"});
    assert.equal(record.input.sha256, await sha256(input));
    assert.equal(record.output.sha256, await sha256(output));
    // The wrap against the original's beats into the loop's first frame (26 levels) and out of its last (10).
    const {match} = record;
    assert.deepEqual([match.frames, match.beats.map(({frames}) => frames)], [[87, 16], [[15, 16], [87, 88]]]);
    assert.ok(Math.abs(match.mean - 16) <= 1.5, `the wrap changes by the 16 levels of a beat: ${match.mean}`);
    assert.ok(Math.abs(match.beats[0].mean - 26) <= 1.5 && Math.abs(match.beats[1].mean - 10) <= 1.5, `the beats: ${JSON.stringify(match.beats)}`);
    assert.ok(Math.abs(match.limit - 2 * match.beats[0].mean) <= 0.002 && Math.abs(match.floor - match.beats[1].mean / 2) <= 0.002, `the bounds: ${match.floor}..${match.limit}`);

    for (const args of [["--beat", "4"], ["--period", "2400", "--beat", "1.5"]]) {
      await assert.rejects(execFileAsync(process.execPath, [SCRIPT, ...args, input]), (error) => error.code === 2
        && error.stderr.includes("--beat takes the frames from one change of the widget to the next"));
    }
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

/** An environment with the render slot in `root`, the machine check `check` (none by default) and no inherited slot. */
function slotEnv(root, check = join(root, "no-machine-check")) {
  const {RENDER_SLOT_HELD: _held, RENDER_SLOT_CEDE: _cede, NODE_TEST_CONTEXT: _context, ...rest} = process.env;
  return {...rest, RENDER_SLOT_DIR: join(root, "render-slot"), RENDER_SLOT_CHECK: "off", MACHINE_CHECK: check};
}

/** cut-loop.mjs in the background: what it printed so far, and its exit status once it ends. */
function background(args, env) {
  const child = spawn(process.execPath, [SCRIPT, ...args], {env, stdio: ["ignore", "pipe", "pipe"]});
  const run = {child, stdout: "", stderr: "", exited: once(child, "close").then(([code]) => code)};
  child.stdout.on("data", (chunk) => { run.stdout += chunk; });
  child.stderr.on("data", (chunk) => { run.stderr += chunk; });
  return run;
}

/** Waits until `ready()` or until `run` ends, for 30 s at most. */
async function until(run, ready) {
  const deadline = Date.now() + 30_000;
  while (!(await ready()) && run.child.exitCode === null && Date.now() < deadline) await sleep(50);
}

const LISTING = changeLevels(100, 40, [[30, 120], [50, 200], [70, 40]]);

test("cut-loop --check measures the loop and writes nothing, and takes no turn in the render slot", media, async () => {
  const root = await mkdtemp(join(tmpdir(), "sws-cut-loop-check-"));
  const env = slotEnv(root);
  const hold = spawn(process.execPath, [RENDER_SLOT, "hold", "--rotulo", "cut-loop-check", "--max", "5"], {env, stdio: ["ignore", "pipe", "ignore"]});
  const released = once(hold, "close");
  try {
    let held = "";
    hold.stdout.on("data", (chunk) => { held += chunk; });
    const input = join(root, "listing.mp4");
    await grayVideo(input, LISTING);
    while (!held.includes("Holding the render slot") && hold.exitCode === null) await sleep(20);
    assert.match(held, /Holding the render slot/);
    // Another process holds the slot, and the check answers at once.
    const checked = await execFileAsync(process.execPath, [SCRIPT, "--check", input], {env, timeout: 30_000});
    assert.match(checked.stdout, /^LOOP listing\.mp4: frames 15\.\.74 \(60 frames, 2\.000 s, 3 cycles of 20\); changes at \[30,50,70\]; frame 15 vs 75: mean \d\.\d{3}; original t = loop t \+ 0\.500 s; --check: nothing encoded or written\n$/);
    assert.equal(await cutLoop(input, {check: true}), checked.stdout.trimEnd());
    // A period that lands on another picture is still NO-LOOP, with exit code 1.
    await assert.rejects(execFileAsync(process.execPath, [SCRIPT, "--check", "--period", "1000", input], {env, timeout: 30_000}), (error) => error.code === 1
      && /^NO-LOOP listing\.mp4: frame 50 changes inside the blend frames 45\.\.52\n$/.test(error.stdout));
    assert.deepEqual((await readdir(root)).filter((name) => !name.startsWith("render-slot")), ["listing.mp4"]);
  } finally {
    hold.kill("SIGTERM");
    await released;
    await rm(root, {recursive: true, force: true});
  }
});

test("cut-loop waits for its turn in the render slot before the encoding ffmpeg starts, and gives the slot back after it", media, async () => {
  const root = await mkdtemp(join(tmpdir(), "sws-cut-loop-turn-"));
  const env = slotEnv(root);
  const hold = spawn(process.execPath, [RENDER_SLOT, "hold", "--rotulo", "cut-loop-turn", "--max", "5"], {env, stdio: ["ignore", "pipe", "ignore"]});
  const released = once(hold, "close");
  let cut;
  try {
    let held = "";
    hold.stdout.on("data", (chunk) => { held += chunk; });
    const input = join(root, "listing.mp4");
    await grayVideo(input, LISTING);
    while (!held.includes("Holding the render slot") && hold.exitCode === null) await sleep(20);
    assert.match(held, /Holding the render slot/);

    cut = background([input], env);
    const ticket = `-${String(cut.child.pid).padStart(7, "0")}.json`;
    await until(cut, async () => (await readdir(`${env.RENDER_SLOT_DIR}.queue`).catch(() => [])).some((name) => name.endsWith(ticket)));
    // Measured, then in the queue behind the hold, with no ffmpeg on the loop's file yet.
    assert.equal(cut.child.exitCode, null, `the cut ended while another process held the slot: ${cut.stdout}${cut.stderr}`);
    assert.match(cut.stderr, /^Waiting for the render slot, held by pid \d+ \(.*hold: cut-loop-turn\)/m);
    await sleep(1000);
    assert.equal(existsSync(join(root, "listing-loop.mp4")), false, "the encode started before its turn");

    hold.kill("SIGTERM");
    assert.equal(await cut.exited, 0, cut.stderr);
    assert.match(cut.stdout, /^LOOP listing\.mp4: frames 15\.\.74 \(60 frames, 2\.000 s, 3 cycles of 20\) -> listing-loop\.mp4;/);
    assert.equal(existsSync(env.RENDER_SLOT_DIR), false, "the cut kept the render slot after its encode");
  } finally {
    hold.kill("SIGTERM");
    cut?.child.kill("SIGTERM");
    await Promise.all([released, cut?.exited]);
    await rm(root, {recursive: true, force: true});
  }
});

test("cut-loop holds the render slot and encodes only once the machine check says the machine is free", media, async () => {
  const root = await mkdtemp(join(tmpdir(), "sws-cut-loop-machine-"));
  const check = join(root, "maquina_livre.py");
  await writeFile(check, ["import json, sys", "print(json.dumps({'livre': False, 'motivos': [], 'reasons': ['the game is open']}))", "sys.exit(3)"].join("\n"));
  const env = slotEnv(root, check);
  let cut;
  try {
    const input = join(root, "listing.mp4");
    await grayVideo(input, LISTING);
    cut = background([input], env);
    await until(cut, () => cut.stderr.includes("Waiting for the machine: the game is open"));
    assert.equal(cut.child.exitCode, null, `the cut ended on a busy machine: ${cut.stdout}${cut.stderr}`);
    assert.match(cut.stderr, /^Waiting for the machine: the game is open$/m);
    assert.ok(existsSync(env.RENDER_SLOT_DIR), "the cut asks the machine check with the slot in hand");
    assert.equal(existsSync(join(root, "listing-loop.mp4")), false, "the encode started on a busy machine");
    // Stopped while it waits, it gives the slot back and leaves nothing.
    cut.child.kill("SIGTERM");
    await cut.exited;
    assert.equal(existsSync(env.RENDER_SLOT_DIR), false);
    assert.deepEqual((await readdir(root)).filter((name) => !name.startsWith("render-slot")).sort(), ["listing.mp4", "maquina_livre.py"]);
  } finally {
    cut?.child.kill("SIGTERM");
    await cut?.exited;
    await rm(root, {recursive: true, force: true});
  }
});
