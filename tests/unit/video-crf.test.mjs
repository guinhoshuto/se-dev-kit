import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {mkdir, mkdtemp, readFile, realpath, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {promisify} from "node:util";
import test from "node:test";

import {detectMediaTooling, encodeFrameSequence} from "../../dist/capture/media.js";
import {recipeSchema} from "../../dist/config/schemas.js";

const execFileAsync = promisify(execFile);

function recipeWith(video) {
  return {
    schemaVersion: 1,
    id: "crf",
    name: "CRF",
    scenes: ["hero"],
    outputs: {video: {enabled: true, durationMs: 1000, fps: 30, ...video}}
  };
}

function issues(video) {
  const parsed = recipeSchema.safeParse(recipeWith(video));
  return parsed.success ? [] : parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
}

test("a recipe sets the H.264 CRF as an integer from 0 to 51, and only for H.264", () => {
  assert.deepEqual(issues({format: "mp4", codec: "h264", crf: 0}), []);
  assert.deepEqual(issues({format: "mp4", crf: 51}), []);
  assert.equal(issues({format: "mp4", crf: 52}).length, 1);
  assert.equal(issues({format: "mp4", crf: -1}).length, 1);
  assert.equal(issues({format: "mp4", crf: 16.5}).length, 1);
  assert.deepEqual(issues({format: "webm", codec: "vp9", crf: 20}), [
    "outputs.video.crf: crf applies only to H.264 MP4; VP9 WebM keeps libvpx's default bitrate"
  ]);
});

/** The CRF x264 wrote into its settings message (an SEI in the first frame), e.g. "crf=16.0". */
async function x264Crf(path) {
  const settings = (await readFile(path)).toString("latin1").match(/x264 - core [^\0]*?\bcrf=(\d+\.\d+)/);
  return settings?.[1];
}

const SETTINGS = [
  {name: "an MP4 without crf is encoded at CRF 16", video: {format: "mp4"}, written: "16.0", encoding: {codec: "h264", crf: 16}},
  {name: "an MP4 with crf 30 is encoded at CRF 30", video: {format: "mp4", crf: 30}, written: "30.0", encoding: {codec: "h264", crf: 30}},
  {name: "a WebM gets no CRF", video: {format: "webm", codec: "vp9"}, written: undefined, encoding: {codec: "vp9", crf: null}}
];

for (const settings of SETTINGS) {
  test(`${settings.name}, and the encode reports the CRF it gave FFmpeg`, {timeout: 60_000}, async (t) => {
    const tooling = await detectMediaTooling();
    if (!tooling.ffmpegPath || !tooling.ffprobePath) {
      t.skip("NOT COVERED: FFmpeg and ffprobe are optional and are not installed; the Studio must not download them implicitly.");
      return;
    }
    const outputRoot = await realpath(await mkdtemp(join(tmpdir(), "sws-video-crf-")));
    t.after(() => rm(outputRoot, {recursive: true, force: true}));
    const frames = join(outputRoot, "frames");
    await mkdir(frames);
    await execFileAsync(tooling.ffmpegPath, ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=64x48:rate=10", "-frames:v", "2", join(frames, "frame-%04d.png")]);
    const outputPath = join(outputRoot, `video.${settings.video.format}`);

    const encoded = await encodeFrameSequence({
      outputRoot,
      framePattern: join(frames, "frame-%04d.png"),
      outputPath,
      video: {enabled: true, durationMs: 200, fps: 10, audio: "none", ...settings.video},
      force: false,
      tooling,
      expectedWidth: 64,
      expectedHeight: 48,
      expectedFrames: 2
    });
    assert.equal(encoded.status, "final");
    assert.deepEqual(encoded.encoding, settings.encoding);
    assert.equal(await x264Crf(outputPath), settings.written);
  });
}
