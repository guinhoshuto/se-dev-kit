import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {mkdir, mkdtemp, realpath, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {promisify} from "node:util";
import {crc32, deflateSync} from "node:zlib";
import test from "node:test";

import {detectMediaTooling, encodeFrameSequence} from "../../dist/capture/media.js";

const execFileAsync = promisify(execFile);

// Saturated primaries and secondaries, where the BT.601 and BT.709 matrices disagree the most, two
// accents and the background of the example's listing video, and a gray both matrices keep.
const COLORS = [
  [255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [0, 255, 255], [255, 0, 255],
  [239, 71, 111], [255, 209, 102], [59, 31, 55], [128, 128, 128]
];
// One flat 32×32 patch per color, on macroblock and chroma boundaries, so no sample mixes two colors.
const PATCH = 32;
const WIDTH = PATCH * COLORS.length;
const HEIGHT = PATCH;

const VIDEOS = [
  {format: "mp4", codec: "h264", pixelFormat: "yuv420p"},
  {format: "webm", codec: "vp9", pixelFormat: "yuv420p"},
  {format: "webm", codec: "vp9", pixelFormat: "yuva420p"}
];

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** An 8-bit RGBA PNG, like the Studio's frame screenshots, with one opaque patch per color. */
function patchesPng() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(WIDTH, 0);
  header.writeUInt32BE(HEIGHT, 4);
  header[8] = 8;
  header[9] = 6;
  const stride = WIDTH * 4 + 1;
  const rows = Buffer.alloc(stride * HEIGHT);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) rows.set([...COLORS[Math.floor(x / PATCH)], 255], y * stride + 1 + x * 4);
  }
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

/** What a browser shows: Chrome decodes BT.709-tagged and untagged video with the BT.709 matrix, limited range. */
function bt709(y, cb, cr) {
  const luma = (y - 16) / 219;
  const red = luma + 1.5748 * ((cr - 128) / 224);
  const blue = luma + 1.8556 * ((cb - 128) / 224);
  const green = (luma - 0.2126 * red - 0.0722 * blue) / 0.7152;
  return [red, green, blue].map((value) => Math.round(Math.min(1, Math.max(0, value)) * 255));
}

for (const settings of VIDEOS) {
  test(`${settings.codec} ${settings.pixelFormat} output is BT.709: tagged, and each patch decodes within 8 levels of its PNG`, {timeout: 60_000}, async (t) => {
    const tooling = await detectMediaTooling();
    if (!tooling.ffmpegPath || !tooling.ffprobePath) {
      t.skip("FFmpeg and ffprobe are optional and are not installed; the Studio must not download them implicitly.");
      return;
    }
    const outputRoot = await realpath(await mkdtemp(join(tmpdir(), "sws-video-color-")));
    t.after(() => rm(outputRoot, {recursive: true, force: true}));
    const frames = join(outputRoot, "frames");
    await mkdir(frames);
    const frame = patchesPng();
    await writeFile(join(frames, "frame-0000.png"), frame);
    await writeFile(join(frames, "frame-0001.png"), frame);
    const outputPath = join(outputRoot, `patches.${settings.format}`);

    const encoded = await encodeFrameSequence({
      outputRoot,
      framePattern: join(frames, "frame-%04d.png"),
      outputPath,
      video: {enabled: true, durationMs: 200, fps: 10, audio: "none", ...settings},
      force: false,
      tooling,
      expectedWidth: WIDTH,
      expectedHeight: HEIGHT,
      expectedFrames: 2
    });
    assert.equal(encoded.status, "final");
    const stream = encoded.metadata.streams.find((candidate) => candidate.codec_type === "video");
    assert.deepEqual(
      {space: stream.color_space, primaries: stream.color_primaries, transfer: stream.color_transfer, range: stream.color_range},
      {space: "bt709", primaries: "bt709", transfer: "bt709", range: "tv"}
    );

    // The first frame's planes as stored, with no conversion by FFmpeg.
    const {stdout: planes} = await execFileAsync(
      tooling.ffmpegPath,
      ["-v", "error", "-i", outputPath, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "yuv420p", "-"],
      {encoding: "buffer", maxBuffer: 16 * 1024 * 1024}
    );
    assert.equal(planes.length, WIDTH * HEIGHT * 1.5, "one yuv420p frame");
    const chroma = (WIDTH / 2) * (HEIGHT / 2);
    const worst = COLORS.map((expected, index) => {
      let difference = 0;
      // The inner 16×16 of each patch: the outer 8 pixels may carry the neighbor's compression ringing.
      for (let y = 8; y < PATCH - 8; y += 1) {
        for (let x = index * PATCH + 8; x < (index + 1) * PATCH - 8; x += 1) {
          const c = (y >> 1) * (WIDTH / 2) + (x >> 1);
          const shown = bt709(planes[y * WIDTH + x], planes[WIDTH * HEIGHT + c], planes[WIDTH * HEIGHT + chroma + c]);
          for (let channel = 0; channel < 3; channel += 1) {
            difference = Math.max(difference, Math.abs(shown[channel] - expected[channel]));
          }
        }
      }
      return {color: expected.join(","), difference};
    });
    const off = worst.filter((patch) => patch.difference >= 8);
    assert.deepEqual(off, [], `patches a browser shows 8 or more levels away from the PNG: ${JSON.stringify(off)}`);
  });
}
