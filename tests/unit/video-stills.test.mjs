// Stills of a stage video (SDK-14): frames copied out as PNG before the frames are discarded, so a Studio
// job, which never publishes frames, still delivers a poster and mid-animation stills.
import assert from "node:assert/strict";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import test from "node:test";

import {estimateRenderBytes} from "../../dist/capture/disk.js";
import {planRecipe} from "../../dist/capture/renderer.js";
import {loadProject} from "../../dist/config/load.js";
import {recipeSchema} from "../../dist/config/schemas.js";
import {videoStillNames} from "../../dist/tutorial/variant.js";

const exampleRoot = fileURLToPath(new URL("../../examples/basic-chat/", import.meta.url));
const video = {enabled: true, durationMs: 1000, fps: 4, format: "mp4", codec: "h264", pixelFormat: "yuv420p", audio: "none"};
const recipe = (extra) => ({schemaVersion: 1, id: "stills", name: "Stills", scenes: ["stills-small"], outputs: {screenshots: false, video: {...video, ...extra}}});

function issues(value) {
  const parsed = recipeSchema.safeParse(value);
  return parsed.success ? [] : parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
}

test("a stage video takes named stills before its end; a tutorial, a repeated name, a bad name, or a still at the end is refused", () => {
  const stills = [{name: "poster", atMs: 0}, {name: "mid-minimize", atMs: 999}];
  assert.deepEqual(issues(recipe({stills})), []);
  assert.deepEqual(recipeSchema.parse(recipe({stills})).outputs.video.stills, stills);
  assert.deepEqual(issues(recipe({mode: "stage", stills})), []);
  assert.deepEqual(issues(recipe({stills: [{name: "end", atMs: 1000}]})), ["outputs.video.stills.0.atMs: a still must be before the end of the video (durationMs 1000)"]);
  assert.deepEqual(issues(recipe({stills: [{name: "a", atMs: 0}, {name: "a", atMs: 500}]})), ['outputs.video.stills.1.name: two stills are named "a"']);
  assert.deepEqual(
    issues(recipe({mode: "tutorial", tutorial: {steps: [{action: "wait", ms: 100}]}, stills: [{name: "a", atMs: 0}]})),
    ["outputs.video.stills: a tutorial video takes its stills from still steps"]
  );
  for (const name of ["Poster", "../x", "a--b", ""]) {
    assert.deepEqual(issues(recipe({stills: [{name, atMs: 0}]})).map((issue) => issue.split(":")[0]), ["outputs.video.stills.0.name"], `name ${JSON.stringify(name)}`);
  }
  for (const atMs of [-1, 1.5]) assert.equal(issues(recipe({stills: [{name: "a", atMs}]})).length, 1, `atMs ${atMs}`);
  assert.equal(issues(recipe({stills: [{name: "a", atMs: 0, camera: "full"}]})).length, 1, "a stage still has no camera");
  const many = (count) => Array.from({length: count}, (_, index) => ({name: `s${index}`, atMs: index}));
  assert.deepEqual(issues(recipe({stills: many(32)})), []);
  assert.equal(issues(recipe({stills: many(33)})).length, 1, "at most 32 stills");
});

test("videoStillNames lists a stage video's stills or a tutorial's still steps, and refuses unsafe or repeated names", () => {
  assert.deepEqual(videoStillNames({...video, stills: [{name: "poster", atMs: 0}, {name: "mid", atMs: 600}]}), ["poster", "mid"]);
  assert.deepEqual(videoStillNames({...video, mode: "stage", stills: [{name: "poster", atMs: 0}]}), ["poster"]);
  assert.deepEqual(videoStillNames({...video, mode: "tutorial", tutorial: {steps: [{action: "still", name: "open"}]}}), ["open"]);
  assert.deepEqual(videoStillNames(video), []);
  assert.deepEqual(videoStillNames({...video, enabled: false, stills: [{name: "poster", atMs: 0}]}), []);
  assert.deepEqual(videoStillNames(undefined), []);
  assert.throws(() => videoStillNames({...video, stills: [{name: "../x", atMs: 0}]}), (error) => error.code === "INVALID_ID");
  assert.throws(
    () => videoStillNames({...video, stills: [{name: "a", atMs: 0}, {name: "a", atMs: 1}]}),
    (error) => error.code === "VIDEO_STILL_DUPLICATE" && /"a"/.test(error.message)
  );
});

test("a stage video's stills are planned targets, so --force guards them, and count in the disk estimate", async () => {
  const project = await loadProject({inputDirectory: exampleRoot});
  project.scenes.push({
    id: "stills-small",
    filePath: "",
    value: {schemaVersion: 1, id: "stills-small", name: "Stills small", viewport: {width: 320, height: 240, deviceScaleFactor: 1}, output: {width: 320, height: 240, format: "png"}}
  });
  // Planning measures the free space of the nearest existing folder and writes nothing.
  const outputRoot = join(tmpdir(), "sws-video-stills-never-written");
  const {plan} = await planRecipe(project, recipe({stills: [{name: "poster", atMs: 0}, {name: "mid", atMs: 600}]}), {
    outputRoot,
    ffmpegPath: "/usr/bin/true",
    ffprobePath: "/usr/bin/true"
  });
  const id = plan.variants[0].id;
  const stills = plan.targets.filter((target) => target.includes("-still-"));
  assert.deepEqual(stills, [resolve(plan.outputRoot, "stills", `${id}-still-poster.png`), resolve(plan.outputRoot, "stills", `${id}-still-mid.png`)]);
  // 4 frames, frames.json, 2 stills, the video, and the manifest; the workload limit counts the same files.
  assert.equal(plan.targets.length, 9);
  assert.equal(plan.totalTargets, 9);
  // Video 4 frames x 320x240 px x 0.05 B/px = 15,360 B; each still is a frame, 320x240 px x 1.2 B/px = 92,160 B.
  assert.equal(plan.estimate.variants[0].persistentBytes, 15_360 + 2 * 92_160);

  const estimate = estimateRenderBytes({
    outputs: {screenshots: false, video: {...video, stills: [{name: "poster", atMs: 0}]}},
    variants: [{id: "v", width: 320, height: 240}],
    framesPerVariant: 4,
    includeVideo: true,
    discardFrames: true
  });
  assert.equal(estimate.variants[0].persistentBytes, 15_360 + 92_160, "a still stays when the frames go");
});
