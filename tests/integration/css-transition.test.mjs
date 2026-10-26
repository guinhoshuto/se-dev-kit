// A Studio video draws a CSS opacity transition over the frames of its duration, and a fade that comes
// out as a cut is the widget's: Chrome starts no transition on a property that a CSS animation holds
// with its fill. On 2026-10-20 se-wheel's `!results` exit stayed whole for 500 ms in a Studio video
// and then cut, and the cut was taken for a capture bug (SDK-53); its `.wrap` kept an entrance keyframe
// with `both` under `transition: opacity 500ms` (fixed in b97de20). The fixture has both boxes.
import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import test from "node:test";

import {detectBrowser, launchStudioBrowser} from "../../dist/capture/browser.js";
import {detectMediaTooling} from "../../dist/capture/media.js";
import {renderRecipe} from "../../dist/capture/renderer.js";
import {loadProject} from "../../dist/config/load.js";

const execFileAsync = promisify(execFile);
const FIXTURE = fileURLToPath(new URL("../fixtures/css-transition/", import.meta.url));
const BOXES = ["plain", "filled"];
// widget.js adds .out at 300 ms; the transition and the visibility delay last 500 ms.
const CHANGE_MS = 300;
const FADE_MS = 500;

/** The red channel at the centre of each box, for every frame of the recipe's video, read from its PNG frames. */
async function boxLevels(t) {
  const [detection, tooling] = await Promise.all([detectBrowser(), detectMediaTooling()]);
  if (!detection.executablePath) {
    t.skip("No compatible local Chromium executable is installed; the Studio must not download one implicitly.");
    return undefined;
  }
  if (!tooling.ffmpegPath || !tooling.ffprobePath) {
    t.skip("FFmpeg and ffprobe are optional and are not installed; the Studio must not download them implicitly.");
    return undefined;
  }
  const outputRoot = await mkdtemp(join(tmpdir(), "sws-css-transition-"));
  t.after(() => rm(outputRoot, {recursive: true, force: true}));
  const project = await loadProject({inputDirectory: FIXTURE});
  const recipe = project.recipes.find((item) => item.id === "fade-video").value;
  const result = await renderRecipe(project, {...recipe, outputs: {...recipe.outputs, video: {...recipe.outputs.video, keepFrames: true}}}, {
    outputRoot,
    browserPath: detection.executablePath,
    ffmpegPath: tooling.ffmpegPath,
    ffprobePath: tooling.ffprobePath
  });
  const entry = JSON.parse(await readFile(result.manifestPath, "utf8")).artifacts[0];
  const {frames} = JSON.parse(await readFile(join(outputRoot, entry.files.framesManifest.file), "utf8"));
  const {width, height} = entry.files.video;
  const {stdout} = await execFileAsync(
    tooling.ffmpegPath,
    ["-v", "error", "-start_number", "0", "-i", join(outputRoot, entry.frames, "frame-%04d.png"), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    {encoding: "buffer", maxBuffer: 64 * 1024 * 1024}
  );
  assert.equal(stdout.length, frames.length * width * height * 3, "one decoded image per frame");
  // The boxes are 60 px squares from x = 10 and x = 90, y = 10, so their centres are (40, 40) and (120, 40).
  return frames.map((frame, index) => ({
    timestampMs: frame.timestampMs,
    ...Object.fromEntries(BOXES.map((box, column) => [box, stdout[(index * width * height + 40 * width + 40 + column * 80) * 3]]))
  }));
}

test("a video draws a CSS opacity transition over the frames of its duration, each at its timestamp's progress", {timeout: 120_000}, async (t) => {
  const levels = await boxLevels(t);
  if (!levels) return;
  t.diagnostic(levels.map((level) => `${level.timestampMs}:${level.plain}/${level.filled}`).join(" "));
  let between = 0;
  for (const {timestampMs, plain} of levels) {
    const progress = Math.min(1, Math.max(0, (timestampMs - CHANGE_MS) / FADE_MS));
    const expected = Math.round(255 * (1 - progress));
    assert.ok(Math.abs(plain - expected) <= 2, `at ${timestampMs} ms the plain box is ${plain}, not ${expected}`);
    if (plain > 0 && plain < 255) between += 1;
  }
  // 30 fps from 300 to 800 ms: the frames at 333 to 767 ms, 14 of them, lie strictly inside the fade.
  assert.ok(between >= 14, `only ${between} frames lie between the box's start and its end`);
});

test("a keyframe whose fill holds opacity keeps a transition from starting, in Chrome and in a video alike", {timeout: 120_000}, async (t) => {
  if (!(await detectBrowser()).executablePath) {
    t.skip("No compatible local Chromium executable is installed; the Studio must not download one implicitly.");
    return;
  }
  // Chrome itself, on its own clock: the animations it creates when .out is added after the entrance.
  const [html, css] = await Promise.all([readFile(join(FIXTURE, "widget.html"), "utf8"), readFile(join(FIXTURE, "widget.css"), "utf8")]);
  const {browser} = await launchStudioBrowser({});
  let created;
  try {
    const page = await browser.newPage({viewport: {width: 170, height: 80}});
    await page.setContent(`<!doctype html><style>${css}</style>${html}`);
    created = await page.evaluate(() => new Promise((done) => {
      setTimeout(() => {
        const boxes = [...document.querySelectorAll(".box")];
        boxes.forEach((box) => box.classList.add("out"));
        done(Object.fromEntries(boxes.map((box) => [
          box.id,
          box.getAnimations().map((animation) => `${animation.constructor.name}:${animation.transitionProperty ?? animation.animationName}`).sort()
        ])));
      }, 400);
    }));
  } finally {
    await browser.close();
  }
  t.diagnostic(JSON.stringify(created));
  assert.deepEqual(created.plain, ["CSSTransition:opacity", "CSSTransition:visibility"]);
  assert.deepEqual(created.filled, ["CSSAnimation:widget-in", "CSSTransition:visibility"], "the filled entrance holds opacity, so no opacity transition starts");

  // The video shows the same: whole until visibility turns hidden at the end of its delay, then gone.
  const levels = await boxLevels(t);
  if (!levels) return;
  for (const {timestampMs, filled} of levels) {
    if (timestampMs < CHANGE_MS) continue;
    const expected = timestampMs < CHANGE_MS + FADE_MS ? 255 : 0;
    assert.equal(filled, expected, `at ${timestampMs} ms the filled box is ${filled}, not ${expected}`);
  }
});
