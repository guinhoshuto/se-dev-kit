import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import test from "node:test";

import {buildInfo} from "../../dist/build-info.js";
import {detectBrowser} from "../../dist/capture/browser.js";
import {detectMediaTooling} from "../../dist/capture/media.js";
import {sha256} from "../../dist/capture/hash.js";
import {planRecipe, renderRecipe, renderSheetAt} from "../../dist/capture/renderer.js";
import {loadProject} from "../../dist/config/load.js";
import {DEFAULT_FIXED_TIME} from "../../dist/scenarios/state.js";
import {stableStringify} from "../../dist/shared/json.js";

const exampleRoot = fileURLToPath(new URL("../../examples/basic-chat/", import.meta.url));

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function temporaryFilesUnder(directory) {
  const found = [];
  for (const entry of await readdir(directory, {recursive: true})) if (/\.sws-[^/]*\.tmp$/.test(entry)) found.push(entry);
  return found.sort();
}

function videoSmokeProject(project, id = "video-smoke") {
  project.scenes.push({
    id,
    filePath: "",
    value: {
      schemaVersion: 1,
      id,
      name: "Video smoke",
      theme: "midnight",
      fixture: "launch-chat",
      viewport: {width: 320, height: 240, deviceScaleFactor: 1},
      output: {width: 320, height: 240, format: "png"},
      camera: {id: "video-smoke-camera", scale: 0.5, x: 0, y: 0},
      background: {id: "video-smoke-background", color: "#10172b"}
    }
  });
  return project;
}

const twoFrameVideo = {
  enabled: true,
  durationMs: 1000,
  fps: 2,
  format: "mp4",
  codec: "h264",
  pixelFormat: "yuv420p",
  audio: "none"
};

function pngDimensions(buffer) {
  assert.deepEqual([...buffer.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  return {width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20)};
}

test("capture writes deterministic images, thumbnail, contact sheet, and provenance without deleting unrelated files", {timeout: 120_000}, async (t) => {
  const detection = await detectBrowser();
  if (!detection.executablePath) {
    t.skip("No compatible local Chromium executable is installed; the Studio must not download one implicitly.");
    return;
  }

  const outputRoot = await mkdtemp(join(tmpdir(), "sws-capture-integration-"));
  t.after(() => rm(outputRoot, {recursive: true, force: true}));
  const sentinel = join(outputRoot, "keep-me.txt");
  await writeFile(sentinel, "unrelated user file");
  const project = await loadProject({inputDirectory: exampleRoot});
  project.scenes.push({
    id: "synthetic-default",
    filePath: "",
    value: {
      schemaVersion: 1,
      id: "synthetic-default",
      name: "Synthetic default",
      viewport: {width: 430, height: 640},
      output: {width: 430, height: 640, format: "png"}
    }
  });
  const recipe = {
    schemaVersion: 1,
    id: "listing-mockups",
    name: "Integration media",
    scenes: ["hero"],
    outputs: {
      screenshots: true,
      thumbnails: {width: 320, height: 240, fit: "contain", format: "png"},
      contactSheet: true
    },
    limit: 1
  };

  const first = await renderRecipe(project, recipe, {
    outputRoot,
    browserPath: detection.executablePath
  });
  assert.equal(first.status, "final");
  assert.ok(first.manifestPath);
  const firstManifest = JSON.parse(await readFile(first.manifestPath, "utf8"));
  const firstEntry = firstManifest.artifacts[0];
  assert.deepEqual(firstManifest.runtime, {
    seed: 1337,
    fixedTime: "2025-01-15T12:00:00.000Z",
    locale: "en-US",
    timezone: "UTC"
  });
  assert.ok(firstManifest.widget.assetHashes["widget.js"]);
  assert.deepEqual(
    pngDimensions(await readFile(join(outputRoot, firstEntry.files.screenshot.file))),
    {width: 1200, height: 1200}
  );
  assert.deepEqual(
    pngDimensions(await readFile(join(outputRoot, firstEntry.files.thumbnail.file))),
    {width: 320, height: 240}
  );
  assert.equal(firstEntry.files.screenshot.mimeType, "image/png");
  assert.equal(firstEntry.files.screenshot.width, 1200);
  assert.equal(firstEntry.files.screenshot.height, 1200);
  assert.ok(firstEntry.files.screenshot.bytes > 0);
  assert.equal(firstManifest.contactSheet.mimeType, "image/png");
  assert.deepEqual(
    pngDimensions(await readFile(join(outputRoot, firstManifest.contactSheet.file))),
    {width: firstManifest.contactSheet.width, height: firstManifest.contactSheet.height}
  );
  // Review codes: a recipe outside the widget's recipes is tagged after them, so it does not take the example's
  // listing-media tag (LM); the screenshot comes first, as on the contact sheet.
  assert.deepEqual(firstManifest.review, {
    tag: "LM2",
    items: [
      {code: "LM2-01", kind: "screenshot", file: firstEntry.files.screenshot.file, variant: firstEntry.id},
      {code: "LM2-02", kind: "thumbnail", file: firstEntry.files.thumbnail.file, variant: firstEntry.id},
      {code: "LM2-03", kind: "contactSheet", file: firstManifest.contactSheet.file}
    ]
  });

  await assert.rejects(
    renderRecipe(project, recipe, {outputRoot, browserPath: detection.executablePath}),
    (error) => error?.code === "OUTPUT_EXISTS" && /--force/.test(error.hint ?? "")
  );
  const second = await renderRecipe(project, recipe, {
    outputRoot,
    browserPath: detection.executablePath,
    force: true
  });
  const secondManifest = JSON.parse(await readFile(second.manifestPath, "utf8"));
  assert.equal(secondManifest.artifacts[0].files.screenshot.sha256, firstEntry.files.screenshot.sha256);
  assert.equal(await readFile(sentinel, "utf8"), "unrelated user file");
});

test("video capture with keepFrames writes deterministic frames and produces an ffprobe-validated silent MP4", {timeout: 90_000}, async (t) => {
  const [detection, tooling] = await Promise.all([detectBrowser(), detectMediaTooling()]);
  if (!detection.executablePath) {
    t.skip("No compatible local Chromium executable is installed; the Studio must not download one implicitly.");
    return;
  }
  if (!tooling.ffmpegPath || !tooling.ffprobePath) {
    t.skip("FFmpeg and ffprobe are optional and are not installed; the Studio must not download them implicitly.");
    return;
  }

  const outputRoot = await mkdtemp(join(tmpdir(), "sws-video-integration-"));
  t.after(() => rm(outputRoot, {recursive: true, force: true}));
  const project = await loadProject({inputDirectory: exampleRoot});
  project.scenes.push({
    id: "video-smoke",
    filePath: "",
    value: {
      schemaVersion: 1,
      id: "video-smoke",
      name: "Video smoke",
      theme: "midnight",
      fixture: "launch-chat",
      viewport: {width: 320, height: 240, deviceScaleFactor: 1},
      output: {width: 320, height: 240, format: "png"},
      camera: {id: "video-smoke-camera", scale: 0.5, x: 0, y: 0},
      background: {id: "video-smoke-background", color: "#10172b"}
    }
  });
  const recipe = {
    schemaVersion: 1,
    id: "integration-video",
    name: "Integration video",
    scenes: ["video-smoke"],
    outputs: {
      screenshots: false,
      video: {
        enabled: true,
        durationMs: 1000,
        fps: 2,
        format: "mp4",
        codec: "h264",
        pixelFormat: "yuv420p",
        audio: "none",
        keepFrames: true
      }
    },
    limit: 1
  };

  const result = await renderRecipe(project, recipe, {
    outputRoot,
    browserPath: detection.executablePath,
    ffmpegPath: tooling.ffmpegPath,
    ffprobePath: tooling.ffprobePath
  });
  assert.equal(result.status, "final");
  assert.equal(result.plan.totalFrames, 2);
  const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
  const entry = manifest.artifacts[0];
  assert.equal(entry.files.video.mimeType, "video/mp4");
  assert.equal(entry.files.video.width, 320);
  assert.equal(entry.files.video.height, 240);
  assert.ok(entry.files.video.bytes > 0);
  assert.deepEqual(entry.videoEncoding, {codec: "h264", crf: 16}, "a recipe without crf is encoded, and recorded, at CRF 16");
  assert.equal(entry.framesRetained, true);
  const frames = JSON.parse(await readFile(join(outputRoot, entry.files.framesManifest.file), "utf8"));
  assert.equal(frames.frames.length, 2);
  assert.deepEqual(frames.frames.map((frame) => frame.timestampMs), [0, 500]);
  assert.ok(frames.frames.every((frame) => /^[a-f0-9]{64}$/.test(frame.sha256)));
  assert.deepEqual(entry.frameSequence, frames, "the manifest carries the frames.json content");
  for (const frame of frames.frames) {
    assert.equal(sha256(await readFile(join(outputRoot, entry.frames, frame.file))), frame.sha256);
  }
  assert.ok(result.artifacts.some((file) => file.endsWith("/frames/frames.json")));
});

test("a validated encode removes only the listed frames and keeps a frame folder that holds an unrelated file", {timeout: 180_000}, async (t) => {
  const [detection, tooling] = await Promise.all([detectBrowser(), detectMediaTooling()]);
  if (!detection.executablePath) {
    t.skip("No compatible local Chromium executable is installed; the Studio must not download one implicitly.");
    return;
  }
  if (!tooling.ffmpegPath || !tooling.ffprobePath) {
    t.skip("FFmpeg and ffprobe are optional and are not installed; the Studio must not download them implicitly.");
    return;
  }

  const outputRoot = await mkdtemp(join(tmpdir(), "sws-video-discard-"));
  t.after(() => rm(outputRoot, {recursive: true, force: true}));
  const project = videoSmokeProject(await loadProject({inputDirectory: exampleRoot}));
  const recipe = {
    schemaVersion: 1,
    id: "integration-discard",
    name: "Integration discard",
    scenes: ["video-smoke"],
    matrix: {
      backgrounds: [
        {id: "navy-stage", color: "#10172b"},
        {id: "warm-stage", color: "#3b1f37"}
      ]
    },
    outputs: {screenshots: false, video: twoFrameVideo}
  };
  const options = {outputRoot, browserPath: detection.executablePath, ffmpegPath: tooling.ffmpegPath, ffprobePath: tooling.ffprobePath};
  const {plan} = await planRecipe(project, recipe, options);
  const [withNotes, clean] = plan.variants.map((variant) => variant.id);
  assert.ok(withNotes && clean);
  const notesDirectory = join(outputRoot, recipe.id, withNotes, "frames");
  await mkdir(notesDirectory, {recursive: true});
  await writeFile(join(notesDirectory, "notes.txt"), "unrelated user file");

  const result = await renderRecipe(project, recipe, options);
  assert.equal(result.status, "final");
  assert.deepEqual(await readdir(notesDirectory), ["notes.txt"], "only the listed frames and frames.json were removed");
  assert.equal(await readFile(join(notesDirectory, "notes.txt"), "utf8"), "unrelated user file");
  assert.equal(await exists(join(outputRoot, recipe.id, clean)), false, "an emptied frame folder and variant folder are removed");
  assert.equal(result.artifacts.some((file) => file.includes("/frames/")), false);
  assert.deepEqual(await temporaryFilesUnder(outputRoot), []);

  const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
  assert.equal(manifest.status, "final");
  assert.equal(manifest.artifacts.length, 2);
  for (const entry of manifest.artifacts) {
    assert.equal(entry.framesRetained, false);
    assert.equal(entry.frames, null);
    assert.equal(entry.files.framesManifest, undefined);
    assert.equal(entry.frameSequence.frames.length, 2);
    assert.deepEqual(entry.frameSequence.frames.map((frame) => frame.timestampMs), [0, 500]);
    assert.ok(entry.frameSequence.frames.every((frame) => /^[a-f0-9]{64}$/.test(frame.sha256)));
    assert.equal(
      entry.hashes.framesManifest,
      sha256(`${stableStringify(entry.frameSequence, 2)}\n`),
      "the recorded hash is the discarded frames.json, reproducible from the manifest"
    );
    const video = await readFile(join(outputRoot, entry.video));
    assert.equal(sha256(video), entry.files.video.sha256);
    assert.equal(entry.files.video.bytes, video.byteLength);
  }
});

test("without FFmpeg, allowIntermediate keeps the PNG sequence and frames.json", {timeout: 180_000}, async (t) => {
  const detection = await detectBrowser();
  if (!detection.executablePath) {
    t.skip("No compatible local Chromium executable is installed; the Studio must not download one implicitly.");
    return;
  }
  const outputRoot = await mkdtemp(join(tmpdir(), "sws-video-intermediate-"));
  t.after(() => rm(outputRoot, {recursive: true, force: true}));
  const project = videoSmokeProject(await loadProject({inputDirectory: exampleRoot}));
  const recipe = {schemaVersion: 1, id: "integration-intermediate", name: "Integration intermediate", scenes: ["video-smoke"], outputs: {screenshots: false, video: twoFrameVideo}};

  const result = await renderRecipe(project, recipe, {
    outputRoot,
    browserPath: detection.executablePath,
    ffmpegPath: join(outputRoot, "missing-ffmpeg"),
    allowIntermediate: true
  });
  assert.equal(result.status, "intermediate");
  const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
  const entry = manifest.artifacts[0];
  assert.equal(entry.video, null);
  assert.equal(entry.framesRetained, true);
  const frames = JSON.parse(await readFile(join(outputRoot, entry.files.framesManifest.file), "utf8"));
  assert.deepEqual(entry.frameSequence, frames);
  for (const frame of frames.frames) assert.equal(await exists(join(outputRoot, entry.frames, frame.file)), true);
});

test("a disk-full encode removes this run's temporary files, keeps another's, and reports what remains", {timeout: 180_000}, async (t) => {
  const detection = await detectBrowser();
  if (!detection.executablePath) {
    t.skip("No compatible local Chromium executable is installed; the Studio must not download one implicitly.");
    return;
  }
  const outputRoot = await mkdtemp(join(tmpdir(), "sws-video-enospc-"));
  t.after(() => rm(outputRoot, {recursive: true, force: true}));
  const fakeFfmpeg = join(outputRoot, "ffmpeg");
  await writeFile(fakeFfmpeg, [
    "#!/bin/sh",
    'if [ "$1" = "-version" ]; then echo "ffmpeg version fake"; exit 0; fi',
    "for last; do :; done",
    'printf partial > "$last"',
    'echo "av_interleaved_write_frame(): No space left on device" >&2',
    "exit 1",
    ""
  ].join("\n"));
  await chmod(fakeFfmpeg, 0o755);
  const project = videoSmokeProject(await loadProject({inputDirectory: exampleRoot}));
  const recipe = {schemaVersion: 1, id: "integration-enospc", name: "Integration disk full", scenes: ["video-smoke"], outputs: {screenshots: false, video: twoFrameVideo}};
  const options = {outputRoot, browserPath: detection.executablePath, ffmpegPath: fakeFfmpeg};
  const {plan} = await planRecipe(project, recipe, options);
  const variant = plan.variants[0].id;
  const recipeDirectory = join(outputRoot, recipe.id);
  const foreign = `.${variant}.mp4.sws-0123456789ab.tmp`;
  await mkdir(recipeDirectory, {recursive: true});
  await writeFile(join(recipeDirectory, foreign), "another process");

  await assert.rejects(renderRecipe(project, recipe, options), (error) => {
    assert.equal(error?.code, "OUTPUT_DISK_FULL", error?.message);
    assert.match(error.message, new RegExp(`video encoding of variant "${variant}" \\(2 of 2 frames written\\)`));
    assert.match(error.message, /0 of 1 variant\(s\) finished/);
    assert.match(error.message, /manifest\.json was not written for this run/);
    assert.match(error.message, /Removed 1 temporary file\(s\) this run had created/);
    assert.ok(error.message.includes(join(recipeDirectory, variant, "frames")));
    assert.match(error.message, /No space left on device/);
    assert.match(error.hint, /--force/);
    return true;
  });
  assert.deepEqual(await temporaryFilesUnder(recipeDirectory), [foreign]);
  assert.equal(await readFile(join(recipeDirectory, foreign), "utf8"), "another process");
  assert.equal(await exists(join(recipeDirectory, "manifest.json")), false);
  assert.equal(await exists(join(recipeDirectory, `${variant}.mp4`)), false);
  assert.deepEqual(
    (await readdir(join(recipeDirectory, variant, "frames"))).sort(),
    ["frame-0000.png", "frame-0001.png", "frames.json"],
    "frames of a failed encode stay"
  );
});

test("an encode that ffprobe cannot validate keeps its frames", {timeout: 180_000}, async (t) => {
  const [detection, tooling] = await Promise.all([detectBrowser(), detectMediaTooling()]);
  if (!detection.executablePath) {
    t.skip("No compatible local Chromium executable is installed; the Studio must not download one implicitly.");
    return;
  }
  if (!tooling.ffmpegPath) {
    t.skip("FFmpeg is optional and is not installed; the Studio must not download it implicitly.");
    return;
  }
  const outputRoot = await mkdtemp(join(tmpdir(), "sws-video-unvalidated-"));
  t.after(() => rm(outputRoot, {recursive: true, force: true}));
  const project = videoSmokeProject(await loadProject({inputDirectory: exampleRoot}));
  const recipe = {schemaVersion: 1, id: "integration-unvalidated", name: "Integration unvalidated", scenes: ["video-smoke"], outputs: {screenshots: false, video: twoFrameVideo}};

  const result = await renderRecipe(project, recipe, {
    outputRoot,
    browserPath: detection.executablePath,
    ffmpegPath: tooling.ffmpegPath,
    ffprobePath: join(outputRoot, "missing-ffprobe")
  });
  assert.equal(result.status, "unvalidated");
  const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
  const entry = manifest.artifacts[0];
  assert.equal(entry.framesRetained, true);
  assert.notEqual(entry.frames, null);
  assert.ok(entry.video);
  const frames = JSON.parse(await readFile(join(outputRoot, entry.files.framesManifest.file), "utf8"));
  assert.equal(frames.frames.length, 2);
  for (const frame of frames.frames) assert.equal(await exists(join(outputRoot, entry.frames, frame.file)), true);
});

test("an encode that fails for another reason also removes only this run's temporary files", {timeout: 180_000}, async (t) => {
  const detection = await detectBrowser();
  if (!detection.executablePath) {
    t.skip("No compatible local Chromium executable is installed; the Studio must not download one implicitly.");
    return;
  }
  const outputRoot = await mkdtemp(join(tmpdir(), "sws-video-ffmpeg-fail-"));
  t.after(() => rm(outputRoot, {recursive: true, force: true}));
  const fakeFfmpeg = join(outputRoot, "ffmpeg");
  await writeFile(fakeFfmpeg, [
    "#!/bin/sh",
    'if [ "$1" = "-version" ]; then echo "ffmpeg version fake"; exit 0; fi',
    "for last; do :; done",
    'printf partial > "$last"',
    'echo "frame-%04d.png: Invalid data found when processing input" >&2',
    "exit 1",
    ""
  ].join("\n"));
  await chmod(fakeFfmpeg, 0o755);
  const project = videoSmokeProject(await loadProject({inputDirectory: exampleRoot}));
  const recipe = {schemaVersion: 1, id: "integration-ffmpeg-fail", name: "Integration FFmpeg failure", scenes: ["video-smoke"], outputs: {screenshots: false, video: twoFrameVideo}};
  const options = {outputRoot, browserPath: detection.executablePath, ffmpegPath: fakeFfmpeg};
  const {plan} = await planRecipe(project, recipe, options);
  const variant = plan.variants[0].id;
  const recipeDirectory = join(outputRoot, recipe.id);
  const foreign = `.${variant}.mp4.sws-0123456789ab.tmp`;
  await mkdir(recipeDirectory, {recursive: true});
  await writeFile(join(recipeDirectory, foreign), "another process");

  await assert.rejects(renderRecipe(project, recipe, options), (error) => {
    assert.equal(error?.code, "FFMPEG_FAILED", error?.message);
    assert.match(error.message, /Invalid data found/);
    return true;
  });
  assert.deepEqual(await temporaryFilesUnder(recipeDirectory), [foreign]);
  assert.equal(await readFile(join(recipeDirectory, foreign), "utf8"), "another process");
  assert.equal(await exists(join(recipeDirectory, `${variant}.mp4`)), false);
});

test("a forced rerun removes the earlier manifest before discarding frames, so a later failure leaves none", {timeout: 180_000}, async (t) => {
  const [detection, tooling] = await Promise.all([detectBrowser(), detectMediaTooling()]);
  if (!detection.executablePath) {
    t.skip("No compatible local Chromium executable is installed; the Studio must not download one implicitly.");
    return;
  }
  if (!tooling.ffmpegPath || !tooling.ffprobePath) {
    t.skip("FFmpeg and ffprobe are optional and are not installed; the Studio must not download them implicitly.");
    return;
  }
  const outputRoot = await mkdtemp(join(tmpdir(), "sws-video-stale-manifest-"));
  t.after(() => rm(outputRoot, {recursive: true, force: true}));
  // Encodes the first variant with the real FFmpeg and fails the second, after the first variant's frames are gone.
  const counter = join(outputRoot, "encodes");
  const flakyFfmpeg = join(outputRoot, "ffmpeg");
  await writeFile(flakyFfmpeg, [
    "#!/bin/sh",
    `if [ "$1" = "-version" ]; then exec "${tooling.ffmpegPath}" "$@"; fi`,
    `if [ -f "${counter}" ]; then echo "Invalid data found when processing input" >&2; exit 1; fi`,
    `touch "${counter}"`,
    `exec "${tooling.ffmpegPath}" "$@"`,
    ""
  ].join("\n"));
  await chmod(flakyFfmpeg, 0o755);
  const project = videoSmokeProject(await loadProject({inputDirectory: exampleRoot}));
  const recipe = {
    schemaVersion: 1,
    id: "integration-stale-manifest",
    name: "Integration stale manifest",
    scenes: ["video-smoke"],
    matrix: {backgrounds: [{id: "navy-stage", color: "#10172b"}, {id: "warm-stage", color: "#3b1f37"}]},
    outputs: {screenshots: false, video: twoFrameVideo}
  };
  const manifestPath = join(outputRoot, recipe.id, "manifest.json");
  await mkdir(join(outputRoot, recipe.id), {recursive: true});
  await writeFile(manifestPath, '{"stale": true}\n');

  await assert.rejects(
    renderRecipe(project, recipe, {outputRoot, browserPath: detection.executablePath, ffmpegPath: flakyFfmpeg, ffprobePath: tooling.ffprobePath, force: true}),
    (error) => error?.code === "FFMPEG_FAILED"
  );
  assert.equal(await exists(manifestPath), false, "no manifest points at the discarded frames");
});

test("a CLI capture records the build and the command-line flags it ran with in the manifest", {timeout: 120_000}, async (t) => {
  const detection = await detectBrowser();
  if (!detection.executablePath) {
    t.skip("No compatible local Chromium executable is installed; the Studio must not download one implicitly.");
    return;
  }
  const outputRoot = await mkdtemp(join(tmpdir(), "sws-capture-cli-"));
  t.after(() => rm(outputRoot, {recursive: true, force: true}));
  const cli = fileURLToPath(new URL("../../dist/cli/index.js", import.meta.url));
  await promisify(execFile)(process.execPath, [cli, "capture", exampleRoot, "--json", "--scene", "hero", "--output", outputRoot, "--force"], {maxBuffer: 16 * 1024 * 1024});
  const manifest = JSON.parse(await readFile(join(outputRoot, "capture-hero", "manifest.json"), "utf8"));
  assert.deepEqual(manifest.studio, {
    name: "se-widget-studio",
    version: buildInfo().version,
    commit: buildInfo().commit,
    dirty: buildInfo().dirty,
    cliFlags: ["--json", "--scene", "hero", "--output", "<path>", "--force"]
  });
});

// A widget whose box a test positions or animates; the still is taken at captureAtMs 1125.
async function timingWidget(t, {css = "", js = ""} = {}) {
  const root = await mkdtemp(join(tmpdir(), "sws-still-timing-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  await Promise.all([
    writeFile(join(root, "widget.html"), '<div id="box"></div>'),
    writeFile(join(root, "widget.css"), `html,body{margin:0;background:transparent}#box{position:absolute;left:0;top:40px;width:40px;height:40px;background:#fff}\n${css}`),
    writeFile(join(root, "widget.js"), js),
    writeFile(join(root, "widget.json"), "{}")
  ]);
  const project = await loadProject({inputDirectory: root});
  project.scenes.push({
    id: "still",
    filePath: "",
    value: {
      schemaVersion: 1,
      id: "still",
      name: "Still",
      viewport: {width: 320, height: 120},
      output: {width: 320, height: 120, format: "png"},
      background: {id: "dark", color: "#10172b"},
      captureAtMs: 1125
    }
  });
  const outputRoot = await mkdtemp(join(tmpdir(), "sws-still-timing-out-"));
  t.after(() => rm(outputRoot, {recursive: true, force: true}));
  return {project, outputRoot};
}

test("a still shows an animation that a timer starts during the replay at its progress, not at its first frame", {timeout: 120_000}, async (t) => {
  const detection = await detectBrowser();
  if (!detection.executablePath) {
    t.skip("No compatible local Chromium executable is installed; the Studio must not download one implicitly.");
    return;
  }
  const recipe = {schemaVersion: 1, id: "still-timing", name: "Still timing", scenes: ["still"], outputs: {screenshots: true}};
  const shot = async (widget) => {
    const result = await renderRecipe(widget.project, recipe, {outputRoot: widget.outputRoot, browserPath: detection.executablePath});
    return JSON.parse(await readFile(result.manifestPath, "utf8")).artifacts[0].hashes.screenshot;
  };
  // With steps(4), the box stands at 100px from 500 to 750 ms into the animation, so the check does not
  // depend on the replay's step: the timer fires at 500 ms and the still is 625 ms into the animation.
  const timed = await timingWidget(t, {
    css: "@keyframes slide{from{transform:translateX(0)}to{transform:translateX(200px)}}#box.go{animation:slide 1000ms steps(4,end) forwards}",
    js: 'setTimeout(() => document.getElementById("box").classList.add("go"), 500);'
  });
  const midway = await timingWidget(t, {css: "#box{transform:translateX(100px)}"});
  const atRest = await timingWidget(t);
  const [timedHash, midwayHash, restHash] = [await shot(timed), await shot(midway), await shot(atRest)];
  assert.notEqual(midwayHash, restHash, "the two references differ");
  assert.notEqual(timedHash, restHash, "the still samples the animation the timer started instead of leaving it at rest");
  assert.equal(timedHash, midwayHash, "625 ms into the animation, the box stands at its 100px step");
});

test("a scene shorter than 88 px renders its still and thumbnail at their exact size instead of hanging", {timeout: 120_000}, async (t) => {
  const detection = await detectBrowser();
  if (!detection.executablePath) {
    t.skip("No compatible local Chromium executable is installed; the Studio must not download one implicitly.");
    return;
  }
  // Headless Chrome never answered the screenshot of a page under 88 px tall once the page was idle, so an
  // 80 px scene waited 30 s and failed (2026-10-04).
  const root = await mkdtemp(join(tmpdir(), "sws-low-scene-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  await Promise.all([
    writeFile(join(root, "widget.html"), '<div id="bar"></div>'),
    writeFile(join(root, "widget.css"), "html,body{margin:0;background:transparent}#bar{position:absolute;inset:8px;background:#fff}"),
    writeFile(join(root, "widget.js"), ""),
    writeFile(join(root, "widget.json"), "{}")
  ]);
  const project = await loadProject({inputDirectory: root});
  project.scenes.push({
    id: "bar",
    filePath: "",
    value: {
      schemaVersion: 1,
      id: "bar",
      name: "Bar",
      viewport: {width: 320, height: 80},
      output: {width: 320, height: 80, format: "png"},
      background: {id: "dark", color: "#10172b"}
    }
  });
  const outputRoot = await mkdtemp(join(tmpdir(), "sws-low-scene-out-"));
  t.after(() => rm(outputRoot, {recursive: true, force: true}));
  const recipe = {schemaVersion: 1, id: "low-scene", name: "Low scene", scenes: ["bar"], outputs: {screenshots: true, thumbnails: {width: 64, height: 48}}};
  const result = await renderRecipe(project, recipe, {outputRoot, browserPath: detection.executablePath});
  const entry = JSON.parse(await readFile(result.manifestPath, "utf8")).artifacts[0];
  assert.deepEqual(pngDimensions(await readFile(join(outputRoot, entry.files.screenshot.file))), {width: 320, height: 80});
  assert.deepEqual(pngDimensions(await readFile(join(outputRoot, entry.files.thumbnail.file))), {width: 64, height: 48});
});

/** The RGBA bytes of an image, row by row, decoded by FFmpeg. */
async function rgbaPixels(ffmpegPath, path) {
  const {stdout} = await promisify(execFile)(ffmpegPath, ["-v", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "rgba", "-"], {encoding: "buffer", maxBuffer: 64 * 1024 * 1024});
  return stdout;
}

function pixelAt(rgba, width, x, y) {
  const offset = (y * width + x) * 4;
  return [rgba[offset], rgba[offset + 1], rgba[offset + 2], rgba[offset + 3]];
}

// Paints its own clock, milliseconds since the capture time as red and green, over the whole scene.
const CLOCK_EPOCH = Date.parse(DEFAULT_FIXED_TIME);
const CLOCK_JS = `function paint() {
  const t = Math.max(0, Date.now() - ${CLOCK_EPOCH});
  document.getElementById("clock").style.background = "rgb(" + (t & 255) + "," + ((t >> 8) & 255) + ",7)";
  requestAnimationFrame(paint);
}
paint();`;

test("a stage video's stills are copies of the frames at their times, written before the frames are discarded", {timeout: 180_000}, async (t) => {
  const [detection, tooling] = await Promise.all([detectBrowser(), detectMediaTooling()]);
  if (!detection.executablePath) {
    t.skip("No compatible local Chromium executable is installed; the Studio must not download one implicitly.");
    return;
  }
  if (!tooling.ffmpegPath || !tooling.ffprobePath) {
    t.skip("FFmpeg and ffprobe are optional and are not installed; the Studio must not download them implicitly.");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "sws-video-stills-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  await Promise.all([
    writeFile(join(root, "widget.html"), '<div id="clock"></div>'),
    writeFile(join(root, "widget.css"), "html,body{margin:0;background:transparent}#clock{position:absolute;inset:0}"),
    writeFile(join(root, "widget.js"), CLOCK_JS),
    writeFile(join(root, "widget.json"), "{}")
  ]);
  const project = await loadProject({inputDirectory: root});
  project.scenes.push({
    id: "clock",
    filePath: "",
    value: {schemaVersion: 1, id: "clock", name: "Clock", viewport: {width: 160, height: 120}, output: {width: 160, height: 120, format: "png"}, background: {id: "dark", color: "#10172b"}}
  });
  const outputRoot = await mkdtemp(join(tmpdir(), "sws-video-stills-out-"));
  t.after(() => rm(outputRoot, {recursive: true, force: true}));
  const recipe = {
    schemaVersion: 1,
    id: "stills",
    name: "Stills",
    scenes: ["clock"],
    // Frames at 0, 250, 500, and 750 ms; 600 ms falls between two of them.
    outputs: {screenshots: false, video: {...twoFrameVideo, fps: 4, stills: [{name: "poster", atMs: 0}, {name: "mid", atMs: 600}]}}
  };
  const result = await renderRecipe(project, recipe, {
    outputRoot,
    browserPath: detection.executablePath,
    ffmpegPath: tooling.ffmpegPath,
    ffprobePath: tooling.ffprobePath
  });
  assert.equal(result.status, "final");
  const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
  const entry = manifest.artifacts[0];
  assert.equal(entry.framesRetained, false, "the frames are discarded after the encode");
  assert.equal(await exists(join(outputRoot, "stills", entry.id, "frames", "frame-0000.png")), false);
  // A still is the first frame at or after its time: 600 ms is frame 3, at 750 ms.
  assert.deepEqual(
    entry.stills.map((still) => [still.name, still.camera, still.atMs, still.frame, still.timestampMs, still.file.file]),
    [
      ["poster", "video", 0, 0, 0, `stills/${entry.id}-still-poster.png`],
      ["mid", "video", 600, 3, 750, `stills/${entry.id}-still-mid.png`]
    ]
  );
  for (const still of entry.stills) {
    const path = join(outputRoot, still.file.file);
    const bytes = await readFile(path);
    assert.equal(sha256(bytes), still.file.sha256);
    // The manifest keeps the discarded frames' hashes: the still is that frame, byte for byte.
    assert.equal(still.file.sha256, entry.frameSequence.frames[still.frame].sha256, `still ${still.name} is frame ${still.frame}`);
    assert.deepEqual([still.file.width, still.file.height], [160, 120]);
    const clock = still.timestampMs;
    assert.deepEqual(pixelAt(await rgbaPixels(tooling.ffmpegPath, path), 160, 80, 60), [clock & 255, (clock >> 8) & 255, 7, 255], `still ${still.name} shows the widget at ${clock} ms`);
    assert.ok(result.artifacts.some((file) => file.endsWith(`/${still.file.file}`)), `still ${still.name} is an artifact, so a Studio job publishes it`);
  }
  assert.deepEqual(
    manifest.review.items.filter((item) => item.kind === "still").map((item) => item.name),
    ["poster", "mid"],
    "the review page shows the stills under their codes"
  );

  // render --sheet-at draws the same way: one 1534 x 418 px cell, where the 160 x 120 px instant scales to
  // 557 x 418 px, centred from x 521.
  const sheetAt = await renderSheetAt(project, recipe, [600], {outputRoot, browserPath: detection.executablePath});
  const sheet = await rgbaPixels(tooling.ffmpegPath, join(outputRoot, sheetAt.sheet));
  for (const x of [524, 800, 1075]) assert.deepEqual(pixelAt(sheet, 1600, x, 242), [600 & 255, (600 >> 8) & 255, 7, 255], `(${x}, 242) shows the widget at 600 ms`);
  for (const x of [518, 1081]) assert.deepEqual(pixelAt(sheet, 1600, x, 242), [0x17, 0x1b, 0x23, 255], `(${x}, 242) is the plain cell`);
});

test("a contact sheet draws each screenshot at its own proportions over a checkerboard, so transparency shows and the cell around it stays plain", {timeout: 120_000}, async (t) => {
  const [detection, tooling] = await Promise.all([detectBrowser(), detectMediaTooling()]);
  if (!detection.executablePath) {
    t.skip("No compatible local Chromium executable is installed; the Studio must not download one implicitly.");
    return;
  }
  if (!tooling.ffmpegPath) {
    t.skip("FFmpeg decodes the sheet here; it is optional and not installed.");
    return;
  }
  // An opaque block over the top-left 160 x 80 px; the rest is transparent. The block is not centred, so an
  // image stretched in either direction moves one of its edges.
  const root = await mkdtemp(join(tmpdir(), "sws-sheet-checker-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  await Promise.all([
    writeFile(join(root, "widget.html"), '<div id="half"></div>'),
    writeFile(join(root, "widget.css"), "html,body{margin:0;background:transparent}#half{position:absolute;left:0;top:0;width:160px;height:80px;background:#e0402a}"),
    writeFile(join(root, "widget.js"), ""),
    writeFile(join(root, "widget.json"), "{}")
  ]);
  const project = await loadProject({inputDirectory: root});
  project.scenes.push({
    id: "half",
    filePath: "",
    value: {schemaVersion: 1, id: "half", name: "Half", viewport: {width: 320, height: 240}, output: {width: 320, height: 240, format: "png"}, background: {id: "clear", color: "transparent"}}
  });
  const outputRoot = await mkdtemp(join(tmpdir(), "sws-sheet-checker-out-"));
  t.after(() => rm(outputRoot, {recursive: true, force: true}));
  const recipe = {schemaVersion: 1, id: "sheet", name: "Sheet", scenes: ["half"], outputs: {screenshots: true, contactSheet: true}};
  const result = await renderRecipe(project, recipe, {outputRoot, browserPath: detection.executablePath});
  const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
  assert.equal(manifest.contactSheet.width, 1600);
  const sheet = await rgbaPixels(tooling.ffmpegPath, join(outputRoot, manifest.contactSheet.file));
  const at = (x, y) => pixelAt(sheet, 1600, x, y);
  const CELL = [0x17, 0x1b, 0x23, 255];
  const BLOCK = [0xe0, 0x40, 0x2a, 255];
  const CHECKER = ["42,46,54,255", "31,34,41,255"];
  // One cell: 32 px of padding, a 1536 x 326 px cell with a 1 px border, so 1534 x 324 px inside, from (33, 33).
  // The 320 x 240 screenshot scales to 432 x 324 px, centred: x 584 to 1015, y 33 to 356.
  for (const [x, y] of [[40, 40], [583, 200], [1016, 200], [1500, 340]]) assert.deepEqual(at(x, y), CELL, `(${x}, ${y}) is the plain cell around the image`);
  // The block scales to x 584 to 799 and y 33 to 140, where scaling blends its edges; the checks stay a few
  // pixels inside it, and inside each transparent region.
  for (const [x, y] of [[586, 35], [700, 90], [796, 138]]) assert.deepEqual(at(x, y), BLOCK, `(${x}, ${y}) is the opaque block`);
  for (const [left, top, right, bottom] of [[804, 35, 1013, 354], [586, 144, 796, 354]]) {
    const counts = new Map();
    let area = 0;
    for (let y = top; y <= bottom; y += 1) {
      for (let x = left; x <= right; x += 1) {
        const key = at(x, y).join(",");
        counts.set(key, (counts.get(key) ?? 0) + 1);
        area += 1;
      }
    }
    for (const color of CHECKER) {
      const share = (counts.get(color) ?? 0) / area;
      if (share < 0.45 || share > 0.55) assert.fail(`transparent pixels from (${left}, ${top}) to (${right}, ${bottom}) are ${(share * 100).toFixed(1)}% rgba(${color}), not half of a checkerboard`);
    }
  }
  // The squares are 8 px, counted from the image's corner at (584, 33).
  assert.notDeepEqual(at(804, 37), at(812, 37), "neighbouring squares alternate");
  assert.deepEqual(at(804, 37), at(812, 45), "diagonal squares match");
});
