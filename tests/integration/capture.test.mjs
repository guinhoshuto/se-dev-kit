import assert from "node:assert/strict";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import test from "node:test";

import {detectBrowser} from "../../dist/capture/browser.js";
import {detectMediaTooling} from "../../dist/capture/media.js";
import {renderRecipe} from "../../dist/capture/renderer.js";
import {loadProject} from "../../dist/config/load.js";

const exampleRoot = fileURLToPath(new URL("../../examples/basic-chat/", import.meta.url));

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
    id: "integration-media",
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

test("video capture writes deterministic frames and produces an ffprobe-validated silent MP4", {timeout: 90_000}, async (t) => {
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
        audio: "none"
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
  const frames = JSON.parse(await readFile(join(outputRoot, entry.files.framesManifest.file), "utf8"));
  assert.equal(frames.frames.length, 2);
  assert.deepEqual(frames.frames.map((frame) => frame.timestampMs), [0, 500]);
  assert.ok(frames.frames.every((frame) => /^[a-f0-9]{64}$/.test(frame.sha256)));
});
