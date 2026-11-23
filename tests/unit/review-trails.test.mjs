import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import {inflateSync} from "node:zlib";
import test from "node:test";

import {encodePng} from "../../dist/capture/png.js";
import {reviewCaption} from "../../dist/capture/review.js";
import {
  boxDownscale,
  drawText,
  maxInto,
  reviewMediaItems,
  secondsLabel,
  sheetFrames,
  sheetStepFor,
  trailOf
} from "../../dist/capture/review-media.js";
import {detectMediaTooling} from "../../dist/capture/media.js";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../../dist/cli/index.js", import.meta.url));

/** A PNG as `encodePng` writes it: 8-bit RGB or RGBA, rows with filter 0. */
function decodePng(bytes) {
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("latin1");
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      channels = data[9] === 6 ? 4 : 3;
    } else if (type === "IDAT") idat.push(data);
    else assert.ok(type === "IEND", `unexpected chunk ${type}`);
    offset += 12 + length;
  }
  const rows = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    assert.equal(rows[y * (stride + 1)], 0, "filter 0");
    rows.copy(pixels, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1));
  }
  return {width, height, channels, pixels, at: (x, y) => [...pixels.subarray((y * width + x) * channels, (y * width + x) * channels + 3)]};
}

const W = 128;
const H = 32;
const FRAMES = 30;
const FPS = 10;

/** Frame i of the moving square: black, a white 16×16 square at y 8–23 and x = 16·floor(i/5). */
function squareFrame(index, width = W, height = H, size = 16) {
  const frame = new Uint8Array(width * height * 3);
  const left = size * Math.floor(index / 5);
  for (let y = 8; y < 8 + size; y += 1) frame.fill(255, (y * width + left) * 3, (y * width + left + size) * 3);
  return frame;
}

async function cli(args) {
  return execFileAsync(process.execPath, [cliPath, "--json", ...args], {maxBuffer: 16 * 1024 * 1024}).then(
    ({stdout}) => ({code: 0, stdout, json: JSON.parse(stdout)}),
    (error) => ({code: error.code, stdout: error.stdout, stderr: error.stderr, error: error.stderr ? JSON.parse(error.stderr) : undefined})
  );
}

/** A render folder `cover/` whose manifest lists `video` for variant a (and a screenshot); writes the screenshot. */
async function coverFolder(root, video) {
  await mkdir(join(root, "cover"), {recursive: true});
  const manifest = {
    schemaVersion: 1,
    generatedAt: "2026-11-22T12:00:00.000Z",
    recipe: {id: "cover"},
    contactSheet: null,
    artifacts: [{id: "a", screenshot: "cover/a.png", video, thumbnail: null}]
  };
  await writeFile(join(root, "cover", "manifest.json"), JSON.stringify(manifest));
  await writeFile(join(root, "cover", "a.png"), encodePng(2, 2, 3, new Uint8Array(12)));
}

/** Fake ffmpeg and ffprobe that record each call in `calls.log` and fail. */
async function fakeTools(root) {
  const log = join(root, "calls.log");
  const tools = {};
  for (const name of ["ffmpeg", "ffprobe"]) {
    const path = join(root, `fake-${name}`);
    await writeFile(path, `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> '${log}'\nexit 1\n`);
    await chmod(path, 0o755);
    tools[name] = path;
  }
  return {log, args: ["--ffmpeg-path", tools.ffmpeg, "--ffprobe-path", tools.ffprobe]};
}

const exists = (path) => stat(path).then(() => true, () => false);

test("review media trail: a moving square's trail is the per-channel maximum of every chosen frame, not a mean", () => {
  const frames = Array.from({length: 10}, (_, index) => squareFrame(index, 96, 32, 16));
  // Every frame: positions 0 (frames 0-4) and 16 (frames 5-9) at full value, the rest black.
  const all = trailOf(frames, 1);
  const pixel = (image, x, y) => [...image.subarray((y * 96 + x) * 3, (y * 96 + x) * 3 + 3)];
  assert.deepEqual(pixel(all, 4, 12), [255, 255, 255], "visited by 5 of 10 frames, still full: a mean would give half");
  assert.deepEqual(pixel(all, 20, 12), [255, 255, 255]);
  assert.deepEqual(pixel(all, 40, 12), [0, 0, 0]);
  assert.deepEqual(pixel(all, 4, 2), [0, 0, 0]);
  // Every 2nd frame of squares at 0, 32, 48, 48: frame 1's square, at 32, is skipped and stays out.
  const sparse = [0, 10, 15, 15].map((index) => squareFrame(index, 96, 32, 16));
  const every2 = trailOf(sparse, 2);
  assert.deepEqual(pixel(every2, 4, 12), [255, 255, 255], "frame 0");
  assert.deepEqual(pixel(every2, 52, 12), [255, 255, 255], "frame 2 (square at 48)");
  assert.deepEqual(pixel(every2, 36, 12), [0, 0, 0], "frame 1 (square at 32) is skipped");
  // Per channel: red then blue on one pixel gives magenta.
  const into = Uint8Array.from([255, 0, 0]);
  maxInto(into, Uint8Array.from([0, 10, 255]));
  assert.deepEqual([...into], [255, 10, 255]);
});

test("review media sheet: frame indexes round up to the first frame at or after each instant below the duration", () => {
  const frames = (count, fps, seconds) => sheetFrames(count, fps, seconds).map((cell) => cell.frame);
  assert.deepEqual(frames(50, 25, 0.5), [0, 13, 25, 38], "S = 0.5 at 25 fps: 12.5 → 13");
  assert.deepEqual(frames(50, 25, 0.25), [0, 7, 13, 19, 25, 32, 38, 44], "6.25 → 7, not 6");
  assert.deepEqual(frames(150, 30, 2), [0, 60, 120], "S = 2 at 30 fps over 5 s");
  assert.deepEqual(frames(60, 30, 1), [0, 30], "the instant at the duration (2 s) is not below it");
  assert.deepEqual(sheetFrames(60, 30, 1).map((cell) => cell.seconds), [0, 1]);
});

test("review media sheet: seconds labels carry the decimals the step needs, from one to three", () => {
  assert.equal(secondsLabel(0, 2), "0.0 s");
  assert.equal(secondsLabel(2, 2), "2.0 s");
  assert.equal(secondsLabel(0.25, 0.25), "0.25 s");
  assert.equal(secondsLabel(0.5, 0.25), "0.50 s");
  assert.equal(secondsLabel(0.375, 0.125), "0.375 s");
  assert.equal(secondsLabel(1 / 3, 1 / 3), "0.333 s");
  assert.equal(sheetStepFor(3), 0.1, "3 s in at most 48 cells");
  assert.ok(sheetFrames(30, 10, sheetStepFor(3)).length <= 48);
  assert.equal(sheetStepFor(120), 2.5);
});

test("review media sheet: the box downscale averages areas, fractional ones included, and never upscales", () => {
  const image = {width: 4, height: 2, data: Uint8Array.from([0, 0, 0, 100, 100, 100, 200, 0, 0, 0, 0, 0, 40, 40, 40, 60, 60, 60, 0, 0, 0, 0, 0, 200])};
  const half = boxDownscale(image, 2);
  assert.deepEqual({width: half.width, height: half.height}, {width: 2, height: 1});
  assert.deepEqual([...half.data], [50, 50, 50, 50, 0, 50]);
  const third = boxDownscale({width: 3, height: 1, data: Uint8Array.from([0, 0, 0, 90, 90, 90, 180, 180, 180])}, 2);
  assert.deepEqual([...third.data], [30, 30, 30, 150, 150, 150]);
  const same = boxDownscale(image, 10);
  assert.deepEqual({width: same.width, height: same.height, data: [...same.data]}, {width: 4, height: 2, data: [...image.data]});
});

test("review media sheet: the bitmap font draws its glyphs and refuses a character it lacks", () => {
  const image = {width: 12, height: 14, data: new Uint8Array(12 * 14 * 3)};
  assert.equal(drawText(image, 0, 0, "1", 2, [255, 255, 255]), 12);
  const lit = [...image.data].filter((value, index) => index % 3 === 0 && value === 255).length;
  assert.equal(lit, 10 * 4, "the glyph 1 has 10 pixels, each 2×2");
  assert.throws(() => drawText(image, 0, 0, "50%", 1), /no glyph for "%"/);
});

test("review media codes: trails then sheets, numbered after the section's highest code, captioned with their source", () => {
  const items = [
    {code: "C-01", kind: "screenshot", file: "cover/a.png", variant: "a"},
    {code: "C-02", kind: "video", file: "cover/a.mp4", variant: "a"},
    {code: "C-03", kind: "video", file: "cover/b.mp4", variant: "b"},
    {code: "C-04", kind: "contactSheet", file: "cover/contact-sheet.png"}
  ];
  const videos = items.filter((item) => item.kind === "video");
  const derived = reviewMediaItems("C", items, videos, {trailEvery: 2, sheetSeconds: 1});
  assert.deepEqual(derived.map((item) => [item.code, item.kind, item.source]), [
    ["C-05", "trail", "C-02"],
    ["C-06", "trail", "C-03"],
    ["C-07", "sheet", "C-02"],
    ["C-08", "sheet", "C-03"]
  ]);
  assert.equal(reviewCaption(derived[0]), "C-05 · a · trail of C-02, every 2nd frame");
  assert.equal(reviewCaption(derived[3]), "C-08 · b · sheet of C-03, every 1 s");
  assert.equal(reviewCaption({...derived[0], every: 1}), "C-05 · a · trail of C-02, every frame");
  // A recorded manifest can skip numbers: the highest one counts, not the count.
  const sparse = reviewMediaItems("C", [{...items[0], code: "C-01"}, {...items[1], code: "C-09"}], [{...items[1], code: "C-09"}], {sheetSeconds: 2});
  assert.deepEqual(sparse.map((item) => item.code), ["C-10"]);
  assert.deepEqual(reviewMediaItems("C", Array.from({length: 99}, (_, index) => ({...items[0], code: `C-${String(index + 1).padStart(2, "0")}`})), [items[1]], {trailEvery: 2}).map((item) => item.code), ["C-100"]);
});

test("review media png: the same pixels always give the same bytes, RGB and RGBA", () => {
  const pixels = Uint8Array.from({length: 5 * 3 * 3}, (_, index) => (index * 37) % 256);
  const png = encodePng(5, 3, 3, pixels);
  assert.deepEqual(png, encodePng(5, 3, 3, Uint8Array.from(pixels)));
  const decoded = decodePng(png);
  assert.deepEqual({width: decoded.width, height: decoded.height, channels: decoded.channels, pixels: [...decoded.pixels]}, {width: 5, height: 3, channels: 3, pixels: [...pixels]});
  assert.equal(decodePng(encodePng(1, 1, 4, Uint8Array.from([1, 2, 3, 4]))).channels, 4);
  assert.throws(() => encodePng(2, 2, 3, new Uint8Array(5)), RangeError);
});

test("review media without --trails or --sheet never looks for FFmpeg and writes the same page", {timeout: 120_000}, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "sws-review-media-")));
  try {
    await coverFolder(root, "cover/a.mp4");
    await writeFile(join(root, "cover", "a.mp4"), "");
    const page = join(root, "index.html");
    const plain = await cli(["review", page, root]);
    assert.equal(plain.code, 0, plain.stderr);
    const before = await readFile(page);
    const withPath = await cli(["review", page, root, "--force", "--ffmpeg-path", join(root, "no-such-ffmpeg"), "--ffprobe-path", join(root, "no-such-ffprobe")]);
    assert.equal(withPath.code, 0, withPath.stderr);
    assert.deepEqual(await readFile(page), before);
    assert.deepEqual(Object.keys(withPath.json).sort(), ["images", "missing", "page", "sections", "videos"]);
    assert.equal(await exists(join(root, "index-media")), false);
    // Asked for, a missing FFmpeg is refused before anything is written.
    const asked = await cli(["review", join(root, "other.html"), root, "--trails", "--ffmpeg-path", join(root, "no-such-ffmpeg")]);
    assert.equal(asked.code, 2);
    assert.equal(asked.error.code, "FFMPEG_NOT_FOUND");
    assert.equal(await exists(join(root, "other.html")), false);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("review media refuses an existing trail file without --force before FFmpeg runs, page included", {timeout: 120_000}, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "sws-review-media-")));
  try {
    await coverFolder(root, "cover/a.mp4");
    await writeFile(join(root, "cover", "a.mp4"), "");
    const fake = await fakeTools(root);
    await mkdir(join(root, "index-media"));
    await writeFile(join(root, "index-media", "C-03-trail.png"), "old");
    const refused = await cli(["review", join(root, "index.html"), join(root, "cover"), "--trails", ...fake.args]);
    assert.equal(refused.code, 2);
    assert.equal(refused.error.code, "OUTPUT_EXISTS");
    assert.match(refused.error.detail, /C-03-trail\.png/);
    assert.equal(await exists(join(root, "index.html")), false, "no page");
    assert.equal(await exists(fake.log), false, "no ffprobe or ffmpeg call");
    assert.equal(await readFile(join(root, "index-media", "C-03-trail.png"), "utf8"), "old");
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("review media decodes only a regular file inside its render folder, by file: URL with the file protocol alone", {timeout: 120_000}, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "sws-review-media-")));
  try {
    const fake = await fakeTools(root);
    await writeFile(join(root, "outside.mp4"), "");
    // URLs and protocols are paths under the folder that do not exist: skipped, never handed to FFmpeg.
    for (const video of ["https://example.invalid/v.mp4", "concat:cover/a.mp4|cover/b.mp4"]) {
      await coverFolder(root, video);
      const result = await cli(["review", join(root, "index.html"), join(root, "cover"), "--force", "--trails", "--sheet", "1", ...fake.args]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.json.skipped.length, 1, video);
      assert.deepEqual(result.json.trails, []);
      assert.equal(await exists(fake.log), false, `${video}: no call`);
    }
    // A file outside the render folder, by path or by symlink, is refused.
    await symlink(join(root, "outside.mp4"), join(root, "cover", "link.mp4"));
    for (const video of ["outside.mp4", "cover/link.mp4"]) {
      await coverFolder(root, video);
      const result = await cli(["review", join(root, "index.html"), join(root, "cover"), "--force", "--trails", ...fake.args]);
      assert.equal(result.code, 2, video);
      assert.equal(result.error.code, "REVIEW_MEDIA_OUTSIDE", video);
      assert.equal(await exists(fake.log), false, `${video}: no call`);
    }
    // The file inside goes to ffprobe as an absolute file: URL, with only the file protocol allowed.
    await coverFolder(root, "cover/a.mp4");
    await writeFile(join(root, "cover", "a.mp4"), "");
    const result = await cli(["review", join(root, "index.html"), join(root, "cover"), "--force", "--trails", ...fake.args]);
    assert.equal(result.error.code, "FFPROBE_FAILED");
    assert.match(await readFile(fake.log, "utf8"), new RegExp(`^ffprobe .*-protocol_whitelist file -i file:${join(root, "cover", "a.mp4")}`, "m"));
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("review media end to end: --trails --sheet 1 over a rendered moving square writes the trail, the sheet, and their codes", {timeout: 240_000}, async (t) => {
  const tooling = await detectMediaTooling();
  if (!tooling.ffmpegPath || !tooling.ffprobePath) {
    t.skip("FFmpeg and ffprobe are optional and are not installed; the Studio must not download them implicitly.");
    return;
  }
  const root = await realpath(await mkdtemp(join(tmpdir(), "sws-review-media-")));
  try {
    await coverFolder(root, "cover/a.mp4");
    const raw = join(root, "frames.rgb");
    await writeFile(raw, Buffer.concat(Array.from({length: FRAMES}, (_, index) => squareFrame(index))));
    await execFileAsync(tooling.ffmpegPath, [
      "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${W}x${H}`, "-r", String(FPS), "-i", raw,
      "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv444p", "-f", "mp4", join(root, "cover", "a.mp4")
    ]);
    const page = join(root, "out", "index.html");
    const result = await cli(["review", page, join(root, "cover"), "--trails", "--sheet", "1"]);
    assert.equal(result.code, 0, result.stderr);
    const media = join(root, "out", "index-media");
    assert.deepEqual(result.json.trails, [{code: "C-03", source: "C-02", file: join(media, "C-03-trail.png")}]);
    assert.deepEqual(result.json.sheets, [{code: "C-04", source: "C-02", file: join(media, "C-04-sheet.png"), cells: 3}]);
    const html = await readFile(page, "utf8");
    assert.match(html, /<a href="index-media\/C-03-trail.png"><img src="index-media\/C-03-trail.png"[^>]*><\/a><figcaption>C-03 · a · trail of C-02, every 2nd frame<\/figcaption>/);
    assert.match(html, /<figcaption>C-04 · a · sheet of C-02, every 1 s<\/figcaption>/);

    // The trail: every position the square visited (x 0–95) bright, the rest dark.
    const trailBytes = await readFile(join(media, "C-03-trail.png"));
    const trail = decodePng(trailBytes);
    assert.deepEqual([trail.width, trail.height], [W, H]);
    const bright = (pixel) => pixel.every((value) => value >= 230);
    const dark = (pixel) => pixel.every((value) => value <= 25);
    for (const x of [4, 20, 36, 52, 68, 84]) assert.ok(bright(trail.at(x, 12)), `x ${x}: ${trail.at(x, 12)}`);
    for (const [x, y] of [[100, 12], [120, 20], [4, 2], [50, 28]]) assert.ok(dark(trail.at(x, y)), `(${x}, ${y}): ${trail.at(x, y)}`);

    // The sheet: 3 cells (0, 1, 2 s of 3 s) of 128×32 in one row, each under its frame.
    const sheet = decodePng(await readFile(join(media, "C-04-sheet.png")));
    assert.deepEqual([sheet.width, sheet.height], [8 + 3 * (W + 8), 8 + H + 24 + 8]);
    for (const [cell, square] of [[0, 0], [1, 32], [2, 64]]) {
      const left = 8 + cell * (W + 8);
      assert.ok(bright(sheet.at(left + square + 4, 8 + 12)), `cell ${cell} shows the square at ${square}`);
      assert.ok(dark(sheet.at(left + ((square + 40) % 96) + 4, 8 + 12)), `cell ${cell} shows only one square`);
    }
    const band = [];
    for (let y = 8 + H; y < 8 + H + 24; y += 1) for (let x = 8; x < 8 + W; x += 1) band.push(sheet.at(x, y).join());
    assert.ok(band.includes("232,234,238"), "a caption is drawn");
    assert.deepEqual(sheet.at(2, 2), [0x0b, 0x0d, 0x12]);

    // A sheet over 48 cells is refused before anything is written, with a larger step in the hint.
    const tooMany = await cli(["review", page, join(root, "cover"), "--force", "--trails", "--sheet", "0.05"]);
    assert.equal(tooMany.code, 2);
    assert.equal(tooMany.error.code, "REVIEW_SHEET_TOO_LARGE");
    assert.match(tooMany.stderr, /--sheet 0\.1 /);

    // --force replaces exactly the trail (same pixels, same bytes) and leaves every other file in the folder.
    await writeFile(join(media, "C-03-trail.png"), "stale");
    await writeFile(join(media, "notes.txt"), "keep");
    const forced = await cli(["review", page, join(root, "cover"), "--force", "--trails"]);
    assert.equal(forced.code, 0, forced.stderr);
    assert.deepEqual(await readFile(join(media, "C-03-trail.png")), trailBytes);
    assert.equal(await readFile(join(media, "notes.txt"), "utf8"), "keep");
    assert.equal(await exists(join(media, "C-04-sheet.png")), true, "the sheet stays");

    // --trail-every 10 keeps frames 0, 10, and 20 only: squares at 0, 32, and 64, not the ones between.
    const sparse = await cli(["review", join(root, "out", "sparse.html"), join(root, "cover"), "--trails", "--trail-every", "10"]);
    assert.equal(sparse.code, 0, sparse.stderr);
    assert.match(await readFile(join(root, "out", "sparse.html"), "utf8"), /<figcaption>C-03 · a · trail of C-02, every 10th frame<\/figcaption>/);
    const sparseTrail = decodePng(await readFile(join(root, "out", "sparse-media", "C-03-trail.png")));
    for (const x of [4, 36, 68]) assert.ok(bright(sparseTrail.at(x, 12)), `x ${x}: ${sparseTrail.at(x, 12)}`);
    for (const x of [20, 52, 84]) assert.ok(dark(sparseTrail.at(x, 12)), `x ${x} is in a skipped frame: ${sparseTrail.at(x, 12)}`);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
