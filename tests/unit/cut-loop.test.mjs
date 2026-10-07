import assert from "node:assert/strict";
import {execFile, spawn} from "node:child_process";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {promisify} from "node:util";
import test from "node:test";

import {cutLoop, findLoop} from "../../skills/se-widget-studio/scripts/cut-loop.mjs";
import {detectMediaTooling} from "../../dist/capture/media.js";

const execFileAsync = promisify(execFile);
// Detected before the first test: a test declared after a top-level await is lost under --test-force-exit.
const tooling = await detectMediaTooling();

/** A motion list: true on every frame of each change, which lasts `length` frames. */
function motion(count, changes, length = 5) {
  const moved = new Array(count).fill(false);
  for (const onset of changes) for (let index = onset; index < onset + length && index < count; index++) moved[index] = true;
  return moved;
}

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

test("cut-loop writes the loop as a tagged BT.709 MP4 whose first frame is the picture after the last change", {skip: tooling.ffmpegPath && tooling.ffprobePath ? false : "NOT COVERED: ffmpeg and ffprobe are missing"}, async () => {
  const root = await mkdtemp(join(tmpdir(), "sws-cut-loop-"));
  try {
    // Three flat states, a 5-frame blend into the next one at 30, 50 and 70, then rest to frame 100.
    const [width, height] = [64, 36];
    const levels = [40, 120, 200];
    const frames = [];
    let state = 0;
    for (let index = 0; index < 100; index++) {
      const onset = [30, 50, 70].find((change) => index >= change && index < change + 5);
      let level = levels[state];
      if (onset !== undefined) level = Math.round(levels[state] + (levels[(state + 1) % 3] - levels[state]) * (index - onset + 1) / 5);
      if (onset !== undefined && index === onset + 4) state = (state + 1) % 3;
      frames.push(Buffer.alloc(width * height, level));
    }
    const input = join(root, "listing.mp4");
    await new Promise((done, fail) => {
      const ffmpeg = spawn(tooling.ffmpegPath, ["-v", "error", "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${width}x${height}`, "-r", "30", "-i", "-",
        "-c:v", "libx264", "-crf", "10", "-pix_fmt", "yuv420p", input]);
      ffmpeg.on("error", fail);
      ffmpeg.on("close", (code) => code === 0 ? done() : fail(new Error(`ffmpeg exited ${code}`)));
      ffmpeg.stdin.end(Buffer.concat(frames));
    });

    assert.match(cutLoop(input), /^LOOP listing\.mp4: frames 15\.\.74 \(60 frames, 2\.000 s, 3 cycles of 20\) -> listing-loop\.mp4;/);
    const output = join(root, "listing-loop.mp4");
    const {stdout} = await execFileAsync(tooling.ffprobePath, ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries",
      "stream=nb_read_frames,color_space,color_primaries,color_transfer,color_range", "-of", "json", output]);
    const stream = JSON.parse(stdout).streams[0];
    assert.deepEqual({...stream}, {color_range: "tv", color_space: "bt709", color_transfer: "bt709", color_primaries: "bt709", nb_read_frames: "60"});
    const first = await execFileAsync(tooling.ffmpegPath, ["-v", "error", "-i", output, "-vf", "select=eq(n\\,0),format=gray", "-frames:v", "1", "-f", "rawvideo", "-"], {encoding: "buffer"});
    const mean = first.stdout.reduce((sum, value) => sum + value, 0) / first.stdout.length;
    assert.ok(Math.abs(mean - 40) <= 2, `the loop starts on the first state, mean luma ${mean}`);

    // An existing loop is never replaced.
    await writeFile(output, "keep");
    assert.equal(cutLoop(input), "FAILED listing.mp4: listing-loop.mp4 already exists; move it away first");
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
