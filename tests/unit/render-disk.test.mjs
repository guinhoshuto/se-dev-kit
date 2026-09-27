import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import test from "node:test";

import {
  assertDiskBudget,
  describeDiskFull,
  diskBudget,
  estimateRenderBytes,
  isNoSpaceError
} from "../../dist/capture/disk.js";
import {encodeFrameSequence} from "../../dist/capture/media.js";
import {atomicWriteFile, discardFrameSequence, removeTemporaryFiles} from "../../dist/capture/output.js";
import {effectiveKeepFrames, planRecipe, renderRecipe, shouldDiscardFrames} from "../../dist/capture/renderer.js";
import {loadProject} from "../../dist/config/load.js";
import {recipeSchema} from "../../dist/config/schemas.js";
import {StudioError} from "../../dist/shared/errors.js";

const execFileAsync = promisify(execFile);
const exampleRoot = fileURLToPath(new URL("../../examples/basic-chat/", import.meta.url));
const cliPath = fileURLToPath(new URL("../../dist/cli/index.js", import.meta.url));

async function temporaryDirectory(t, prefix) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  t.after(() => rm(directory, {recursive: true, force: true}));
  return directory;
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function runCli(args) {
  try {
    const {stdout, stderr} = await execFileAsync(process.execPath, [cliPath, ...args], {maxBuffer: 64 * 1024 * 1024});
    return {code: 0, stdout, stderr};
  } catch (error) {
    return {code: error.code, stdout: error.stdout, stderr: error.stderr};
  }
}

const smallVideo = {enabled: true, durationMs: 1000, fps: 2, format: "mp4", codec: "h264", pixelFormat: "yuv420p", audio: "none"};

function smallVideoProject(project) {
  project.scenes.push({
    id: "disk-small",
    filePath: "",
    value: {
      schemaVersion: 1,
      id: "disk-small",
      name: "Disk small",
      viewport: {width: 320, height: 240, deviceScaleFactor: 1},
      output: {width: 320, height: 240, format: "png"}
    }
  });
  return {schemaVersion: 1, id: "disk-small-video", name: "Disk small video", scenes: ["disk-small"], outputs: {screenshots: false, video: smallVideo}};
}

test("the byte estimate counts PNG frames at 1.2 bytes per output pixel and peaks at one variant's frames when they are discarded", () => {
  const input = {
    outputs: {screenshots: false, video: smallVideo},
    variants: [
      {id: "small", width: 320, height: 240},
      {id: "large", width: 640, height: 480}
    ],
    framesPerVariant: 2,
    includeVideo: true
  };
  const discarded = estimateRenderBytes({...input, discardFrames: true});
  // 320x240 px x 1.2 B/px = 92,160 B per frame, plus a 256 B frame record; video at 0.05 B/px per frame.
  assert.deepEqual(discarded.variants[0], {id: "small", frames: 2, frameBytes: 184_832, persistentBytes: 7_680, totalBytes: 192_512});
  // 640x480 px x 1.2 B/px = 368,640 B per frame.
  assert.deepEqual(discarded.variants[1], {id: "large", frames: 2, frameBytes: 737_792, persistentBytes: 30_720, totalBytes: 768_512});
  assert.equal(discarded.manifestBytes, 271_360);
  assert.equal(discarded.totalBytes, 1_232_384);
  assert.equal(discarded.finalBytes, 309_760, "discarded frames do not stay on disk");
  assert.equal(discarded.peakBytes, 309_760 + 737_792, "only the largest variant's frames exist at once");
  assert.deepEqual(discarded.bytesPerPixel, {png: 1.2, frame: 1.2, video: 0.05});

  const kept = estimateRenderBytes({...input, discardFrames: false});
  assert.equal(kept.finalBytes, 1_232_384);
  assert.equal(kept.peakBytes, 1_232_384, "kept frames of every variant are on disk together");

  const capped = estimateRenderBytes({...input, discardFrames: true, maximumVideoBytes: 1_000});
  assert.equal(capped.variants[1].persistentBytes, 1_000, "a preset's maximum video size caps the video estimate");

  const stills = estimateRenderBytes({
    outputs: {screenshots: true, thumbnails: {width: 600, height: 600}, contactSheet: true},
    variants: [{id: "a", width: 1200, height: 1200}, {id: "b", width: 1200, height: 1200}, {id: "c", width: 1200, height: 1200}],
    framesPerVariant: 0,
    includeVideo: true,
    discardFrames: false
  });
  // Still 1,728,000 B plus thumbnail 432,000 B; the contact sheet is 1600 x (80 + 390) px.
  assert.equal(stills.variants[0].persistentBytes, 2_160_000);
  assert.equal(stills.contactSheetBytes, 902_400);

  // Tutorial frames are mostly flat UI (0.076 B/px measured), so their frames use 0.3 B/px; stills keep 1.2.
  const tutorial = estimateRenderBytes({
    outputs: {screenshots: true, video: {...smallVideo, mode: "tutorial"}},
    variants: [{id: "t", width: 320, height: 240}],
    framesPerVariant: 2,
    includeVideo: true,
    discardFrames: true
  });
  assert.equal(tutorial.variants[0].frameBytes, 2 * (23_040 + 256));
  assert.equal(tutorial.variants[0].persistentBytes, 92_160 + 7_680);
  assert.deepEqual(tutorial.bytesPerPixel, {png: 1.2, frame: 0.3, video: 0.05});
});

test("the estimate counts the cropped pixel size, not the output size", async () => {
  const project = await loadProject({inputDirectory: exampleRoot});
  const recipe = smallVideoProject(project);
  const scene = project.scenes.find((item) => item.id === "disk-small").value;
  scene.crop = {x: 0, y: 0, width: 100, height: 50};
  const {plan} = await planRecipe(project, recipe, {ffmpegPath: "/usr/bin/true", ffprobePath: "/usr/bin/true"});
  // 100x50 px x 1.2 B/px = 6,000 B per frame, plus a 256 B record, for 2 frames.
  assert.equal(plan.estimate.variants[0].frameBytes, 2 * (6_000 + 256));
});

test("the disk budget allows a peak up to 70% of free space and refuses above it unless low disk is allowed", () => {
  assert.equal(diskBudget("/volume", 1_000, 700).withinBudget, true);
  const over = diskBudget("/volume", 1_000, 701);
  assert.equal(over.withinBudget, false);
  assert.equal(over.budgetBytes, 700);
  assert.match(over.summary, /--allow-low-disk/);
  assert.throws(
    () => assertDiskBudget("big", over, false),
    (error) => error?.code === "OUTPUT_DISK_LOW"
      && /701 bytes/.test(error.message)
      && /1000 bytes\) free/.test(error.message)
      && /70% of free space/.test(error.message)
      && /--allow-low-disk/.test(error.hint)
  );
  assert.doesNotThrow(() => assertDiskBudget("big", over, true));
});

test("a render stops before writing when the peak exceeds 70% of the free space statfs reports, and allowLowDisk passes the guard", async (t) => {
  const root = await temporaryDirectory(t, "sws-disk-guard-");
  const outputRoot = join(root, "out");
  const project = await loadProject({inputDirectory: exampleRoot});
  const recipe = smallVideoProject(project);
  const queried = [];
  const statfsWithFree = (freeBytes) => async (path) => {
    queried.push(path);
    return {bavail: BigInt(freeBytes), bsize: 1n};
  };
  const {plan} = await planRecipe(project, recipe, {outputRoot, statfs: statfsWithFree(Number.MAX_SAFE_INTEGER)});
  const peak = plan.estimate.peakBytes;
  assert.ok(peak > 0);
  assert.equal(queried[0], root, "free space is measured on the nearest existing ancestor of the output root");
  const missingBrowser = join(root, "missing-chrome");

  const tightFree = Math.ceil(peak / 0.75);
  await assert.rejects(
    renderRecipe(project, recipe, {outputRoot, browserPath: missingBrowser, statfs: statfsWithFree(tightFree)}),
    (error) => error?.code === "OUTPUT_DISK_LOW"
      && error.message.includes(`${peak} bytes`)
      && error.message.includes(`${tightFree} bytes) free`)
      && /--allow-low-disk/.test(error.hint)
  );
  assert.equal(await exists(outputRoot), false, "a refused render creates nothing");

  // Passing the guard reaches the browser launch, which fails on the missing executable instead.
  await assert.rejects(
    renderRecipe(project, recipe, {outputRoot, browserPath: missingBrowser, statfs: statfsWithFree(tightFree), allowLowDisk: true}),
    (error) => error?.code === "BROWSER_NOT_FOUND"
  );
  await assert.rejects(
    renderRecipe(project, recipe, {outputRoot, browserPath: missingBrowser, statfs: statfsWithFree(Math.floor(peak / 0.65))}),
    (error) => error?.code === "BROWSER_NOT_FOUND"
  );
});

test("the dry run reports the byte estimate per variant, in total, and against free space", async () => {
  const render = await runCli(["render", exampleRoot, "--recipe", "listing-media", "--dry-run", "--json"]);
  assert.equal(render.code, 0, render.stderr);
  const {plan, status} = JSON.parse(render.stdout);
  assert.equal(status, "dry-run");
  assert.equal(plan.estimate.variants.length, 4);
  for (const variant of plan.estimate.variants) {
    // 36 frames of 1200x1200 px at 1.2 B/px, each with a 256 B frame record.
    assert.equal(variant.frames, 36);
    assert.equal(variant.frameBytes, 36 * (1_728_000 + 256));
    assert.equal(variant.totalBytes, variant.frameBytes + variant.persistentBytes);
  }
  const sum = plan.estimate.variants.reduce((total, variant) => total + variant.totalBytes, 0);
  assert.equal(plan.estimate.totalBytes, sum + plan.estimate.contactSheetBytes + plan.estimate.manifestBytes);
  assert.ok(plan.estimate.peakBytes > 0 && plan.estimate.peakBytes <= plan.estimate.totalBytes);
  assert.equal(plan.disk.peakBytes, plan.estimate.peakBytes);
  assert.ok(plan.disk.freeBytes > 0);
  assert.equal(plan.disk.budgetPercent, 70);
  assert.match(plan.disk.summary, /^Estimated peak /);

  const record = await runCli(["record", exampleRoot, "--scene", "hero", "--dry-run", "--json"]);
  assert.equal(record.code, 0, record.stderr);
  assert.equal(JSON.parse(record.stdout).plan.estimate.variants[0].frames, 150);
});

test("the CLI refuses a render above the disk budget and --allow-low-disk lets it continue", async (t) => {
  const root = await temporaryDirectory(t, "sws-disk-cli-");
  await mkdir(join(root, "scenes"));
  await mkdir(join(root, "recipes"));
  await writeFile(join(root, "widget.html"), '<main id="widget">Widget</main>\n');
  await writeFile(join(root, "widget.css"), "#widget { color: white; }\n");
  await writeFile(join(root, "widget.js"), "window.__widgetLoaded = true;\n");
  await writeFile(join(root, "widget.json"), "{}\n");
  await writeFile(
    join(root, "se-widget-studio.config.mjs"),
    'export default {schemaVersion: 1, widget: {root: "."}, scenes: {glob: "scenes/*.json"}, recipes: {glob: "recipes/*.json"}};\n'
  );
  await writeFile(join(root, "scenes", "huge.json"), JSON.stringify({
    schemaVersion: 1,
    id: "huge",
    name: "Huge",
    viewport: {width: 430, height: 640},
    output: {width: 16384, height: 16384, format: "png"}
  }));
  // 600 frames of 16384x16384 px estimate about 176 TiB, beyond any real volume.
  await writeFile(join(root, "recipes", "huge-video.json"), JSON.stringify({
    schemaVersion: 1,
    id: "huge-video",
    name: "Huge video",
    scenes: ["huge"],
    outputs: {screenshots: false, video: {...smallVideo, durationMs: 600_000, fps: 1}}
  }));
  const outputRoot = join(root, "out");
  const base = ["render", root, "--recipe", "huge-video", "--output", outputRoot, "--json"];

  const refused = await runCli(base);
  assert.equal(refused.code, 2);
  const refusal = JSON.parse(refused.stderr);
  assert.equal(refusal.code, "OUTPUT_DISK_LOW", refused.stderr);
  assert.match(refusal.hint, /--allow-low-disk/);
  assert.equal(await exists(outputRoot), false);

  const allowed = await runCli([...base, "--allow-low-disk", "--browser-path", join(root, "missing-chrome")]);
  assert.equal(JSON.parse(allowed.stderr).code, "BROWSER_NOT_FOUND", allowed.stderr);

  const recordHelp = await runCli(["record", "--help"]);
  assert.match(recordHelp.stdout, /--allow-low-disk/);
  assert.match(recordHelp.stdout, /--keep-frames/);
  assert.match((await runCli(["capture", "--help"])).stdout, /--allow-low-disk/);
  assert.match((await runCli(["render", "--help"])).stdout, /--keep-frames/);

  const recordOutput = join(root, "record-out");
  const recordBase = ["record", root, "--scene", "huge", "--output", recordOutput, "--json"];
  const recordRefused = await runCli(recordBase);
  assert.equal(JSON.parse(recordRefused.stderr).code, "OUTPUT_DISK_LOW", recordRefused.stderr);
  assert.equal(await exists(recordOutput), false);
  const recordAllowed = await runCli([...recordBase, "--allow-low-disk", "--browser-path", join(root, "missing-chrome")]);
  assert.equal(JSON.parse(recordAllowed.stderr).code, "BROWSER_NOT_FOUND", recordAllowed.stderr);
});

test("--keep-frames reaches the plan for record and render", async () => {
  const tools = ["--ffmpeg-path", "/usr/bin/true", "--ffprobe-path", "/usr/bin/true", "--dry-run", "--json"];
  const discardFrames = async (args) => {
    const run = await runCli([...args, ...tools]);
    assert.equal(run.code, 0, run.stderr);
    return JSON.parse(run.stdout).plan.estimate.discardFrames;
  };
  const record = ["record", exampleRoot, "--scene", "hero"];
  const render = ["render", exampleRoot, "--recipe", "listing-media"];
  assert.equal(await discardFrames(record), true);
  assert.equal(await discardFrames([...record, "--keep-frames"]), false);
  assert.equal(await discardFrames(render), true);
  assert.equal(await discardFrames([...render, "--keep-frames"]), false);
});

test("discarding a frame sequence removes only the listed files and frames.json, and folders only when empty", async (t) => {
  const root = await temporaryDirectory(t, "sws-discard-");
  const outputRoot = join(root, "out");
  const recipeDirectory = join(outputRoot, "recipe");
  const keptFrames = join(recipeDirectory, "with-notes", "frames");
  const cleanFrames = join(recipeDirectory, "clean", "frames");
  await mkdir(keptFrames, {recursive: true});
  await mkdir(cleanFrames, {recursive: true});
  await writeFile(join(root, "outside.png"), "outside");
  for (const directory of [keptFrames, cleanFrames]) {
    await writeFile(join(directory, "frame-0000.png"), "frame 0");
    await writeFile(join(directory, "frame-0001.png"), "frame 1");
    await writeFile(join(directory, "frames.json"), "{}\n");
  }
  await writeFile(join(keptFrames, "notes.txt"), "unrelated user file");
  await writeFile(join(keptFrames, "frame-0099.png"), "unlisted frame");
  await symlink(join(root, "outside.png"), join(keptFrames, "frame-0002.png"));

  const withNotes = await discardFrameSequence({
    outputRoot,
    framesDirectory: keptFrames,
    frameFiles: ["frame-0000.png", "frame-0001.png", "frame-0002.png"]
  });
  assert.equal(withNotes.removedFiles, 3, "two listed frames and frames.json; the listed symlink is not a regular file");
  assert.deepEqual(withNotes.removedDirectories, []);
  assert.deepEqual((await readdir(keptFrames)).sort(), ["frame-0002.png", "frame-0099.png", "notes.txt"]);
  assert.equal(await readFile(join(keptFrames, "notes.txt"), "utf8"), "unrelated user file");
  assert.equal(await readFile(join(root, "outside.png"), "utf8"), "outside", "a symlink target is never touched");

  const clean = await discardFrameSequence({outputRoot, framesDirectory: cleanFrames, frameFiles: ["frame-0000.png", "frame-0001.png"]});
  assert.equal(clean.removedFiles, 3);
  assert.deepEqual(clean.removedDirectories, [cleanFrames, join(recipeDirectory, "clean")]);
  assert.equal(await exists(join(recipeDirectory, "clean")), false);
  assert.equal(await exists(recipeDirectory), true, "the recipe folder is never removed");

  const escapeFrames = join(recipeDirectory, "escape", "frames");
  await mkdir(escapeFrames, {recursive: true});
  await writeFile(join(escapeFrames, "frame-0000.png"), "frame 0");
  await writeFile(join(recipeDirectory, "escape", "victim.png"), "victim");
  await assert.rejects(
    discardFrameSequence({outputRoot, framesDirectory: escapeFrames, frameFiles: ["frame-0000.png", "../victim.png"]}),
    (error) => error?.code === "FRAME_PATH_INVALID"
  );
  assert.equal(await exists(join(escapeFrames, "frame-0000.png")), true, "nothing is deleted when any listed name is unsafe");
  assert.equal(await exists(join(recipeDirectory, "escape", "victim.png")), true);

  // A frame folder or variant folder that is a symbolic link out of the output root is refused untouched.
  const outsideVariant = join(root, "outside-variant");
  const outside = join(outsideVariant, "frames");
  await mkdir(outside, {recursive: true});
  await writeFile(join(outside, "frame-0000.png"), "outside frame");
  await writeFile(join(outside, "frames.json"), "{}\n");
  await mkdir(join(recipeDirectory, "linked"), {recursive: true});
  await symlink(outside, join(recipeDirectory, "linked", "frames"));
  await symlink(outsideVariant, join(recipeDirectory, "linked-variant"));
  for (const framesDirectory of [join(recipeDirectory, "linked", "frames"), join(recipeDirectory, "linked-variant", "frames")]) {
    await assert.rejects(
      discardFrameSequence({outputRoot, framesDirectory, frameFiles: ["frame-0000.png"]}),
      (error) => error?.code === "OUTPUT_SYMLINK",
      framesDirectory
    );
  }
  assert.deepEqual((await readdir(outside)).sort(), ["frame-0000.png", "frames.json"]);
});

test("frames are discarded only after a validated encode and never when kept", async () => {
  assert.equal(shouldDiscardFrames(false, "final"), true);
  assert.equal(shouldDiscardFrames(true, "final"), false);
  assert.equal(shouldDiscardFrames(false, "unvalidated"), false, "FFmpeg without ffprobe keeps the frames");
  assert.equal(shouldDiscardFrames(false, "intermediate"), false, "without FFmpeg the frames are the output");

  const recipe = {schemaVersion: 1, id: "r", name: "R", scenes: ["hero"], outputs: {screenshots: false, video: {...smallVideo}}};
  const keepingRecipe = {...recipe, outputs: {screenshots: false, video: {...smallVideo, keepFrames: true}}};
  assert.equal(effectiveKeepFrames(recipe), false);
  assert.equal(effectiveKeepFrames(keepingRecipe), true);
  assert.equal(effectiveKeepFrames(recipe, {keepFrames: true}), true);
  assert.equal(effectiveKeepFrames(keepingRecipe, {keepFrames: false}), false, "the render option wins over the recipe");

  const project = await loadProject({inputDirectory: exampleRoot});
  const tools = {ffmpegPath: "/usr/bin/true", ffprobePath: "/usr/bin/true"};
  const discarding = (await planRecipe(project, recipe, tools)).plan.estimate;
  const keeping = (await planRecipe(project, keepingRecipe, tools)).plan.estimate;
  assert.equal(discarding.discardFrames, true);
  assert.equal(keeping.discardFrames, false);
  assert.equal((await planRecipe(project, recipe, {...tools, keepFrames: true})).plan.estimate.discardFrames, false);
  assert.ok(discarding.finalBytes < keeping.finalBytes, "discarded frames are not counted in the final size");
  const noProbe = (await planRecipe(project, recipe, {ffmpegPath: "/usr/bin/true", ffprobePath: join(exampleRoot, "missing-ffprobe")})).plan.estimate;
  assert.equal(noProbe.discardFrames, false, "an encode that cannot be probed keeps its frames");
});

test("a failed encode leaves only a tracked temporary video, and cleanup removes tracked files and nothing else", async (t) => {
  const root = await temporaryDirectory(t, "sws-temporary-");
  const outputRoot = join(root, "out");
  const recipeDirectory = join(outputRoot, "recipe");
  await mkdir(recipeDirectory, {recursive: true});
  const fakeFfmpeg = join(root, "ffmpeg");
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
  const foreign = join(recipeDirectory, ".variant.mp4.sws-0123456789ab.tmp");
  await writeFile(foreign, "another process");

  const temporaryFiles = new Set();
  let failure;
  await assert.rejects(
    encodeFrameSequence({
      outputRoot,
      framePattern: join(recipeDirectory, "variant", "frames", "frame-%04d.png"),
      outputPath: join(recipeDirectory, "variant.mp4"),
      video: smallVideo,
      force: false,
      tooling: {ffmpegPath: fakeFfmpeg},
      expectedWidth: 320,
      expectedHeight: 240,
      temporaryFiles
    }),
    (error) => {
      failure = error;
      return error?.code === "FFMPEG_FAILED";
    }
  );
  assert.equal(isNoSpaceError(failure), true);
  assert.equal(temporaryFiles.size, 1);
  const [own] = temporaryFiles;
  assert.match(own, /\.variant\.mp4\.sws-[a-f0-9]{12}\.tmp$/);
  assert.equal(await readFile(own, "utf8"), "partial");

  assert.equal(await removeTemporaryFiles(temporaryFiles), 1);
  assert.equal(temporaryFiles.size, 0);
  assert.equal(await exists(own), false);
  assert.equal(await readFile(foreign, "utf8"), "another process", "a temporary file this run did not create stays");

  await atomicWriteFile(outputRoot, join(recipeDirectory, "manifest.json"), "{}\n", temporaryFiles);
  assert.equal(temporaryFiles.size, 0, "a committed file is no longer tracked");
  assert.equal(await removeTemporaryFiles(temporaryFiles), 0);
  assert.equal(await readFile(join(recipeDirectory, "manifest.json"), "utf8"), "{}\n");
});

test("disk-full errors are recognized and explained with what remains", () => {
  const enospc = Object.assign(new Error("ENOSPC: no space left on device, write"), {code: "ENOSPC"});
  assert.equal(isNoSpaceError(enospc), true);
  assert.equal(isNoSpaceError(new StudioError("FFMPEG_FAILED", "FFmpeg exited with code 1: No space left on device")), true);
  assert.equal(isNoSpaceError(new Error("page.screenshot: ENOSPC: no space left on device, open '/x.png'")), true);
  assert.equal(isNoSpaceError(new StudioError("WRAPPED", "wrapped", undefined, {cause: enospc})), true);
  assert.equal(isNoSpaceError(Object.assign(new Error("EACCES: permission denied"), {code: "EACCES"})), false);
  assert.equal(isNoSpaceError(undefined), false);

  const message = describeDiskFull({
    progress: {
      recipeDirectory: "/out/listing",
      totalVariants: 3,
      completedVariants: ["first"],
      variant: "second",
      step: "video frames",
      framesWritten: 12,
      framesPlanned: 36,
      framesDirectory: "/out/listing/second/frames"
    },
    removedTemporaryFiles: 1,
    peakBytes: 83_191_808,
    freeBytes: 0,
    cause: enospc
  });
  assert.match(message, /ran out of space during the video frames of variant "second" \(12 of 36 frames written\)/);
  assert.match(message, /1 of 3 variant\(s\) finished; their final files remain in \/out\/listing\./);
  assert.match(message, /manifest\.json was not written for this run/);
  assert.match(
    message,
    /Removed 1 temporary file\(s\) this run had created; apart from the frames of finished variants, removed after their validated encode, no other file was deleted\./
  );
  assert.match(message, /The frames written for "second" remain in \/out\/listing\/second\/frames\./);
  assert.match(message, /Free space now: 0 B; estimated peak for this render: 79\.3 MiB\./);
  assert.match(message, /Cause: ENOSPC: no space left on device, write/);

  const atManifest = describeDiskFull({
    progress: {recipeDirectory: "/out/listing", totalVariants: 3, completedVariants: ["a", "b", "c"], step: "manifest", framesWritten: 0, framesPlanned: 0},
    removedTemporaryFiles: 0,
    peakBytes: 1_024,
    cause: enospc
  });
  assert.match(atManifest, /during the manifest\. 3 of 3 variant\(s\) finished/);
  assert.doesNotMatch(atManifest, /frames written/);
  assert.match(atManifest, /Free space now: unknown/);
});

test("the recipe schema accepts only a boolean keepFrames", () => {
  const base = {schemaVersion: 1, id: "kept", name: "Kept", scenes: ["hero"]};
  assert.equal(recipeSchema.safeParse({...base, outputs: {video: {...smallVideo, keepFrames: true}}}).success, true);
  assert.equal(recipeSchema.safeParse({...base, outputs: {video: {...smallVideo, keepFrames: "yes"}}}).success, false);
});
