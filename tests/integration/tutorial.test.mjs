import assert from "node:assert/strict";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import test from "node:test";

import {detectBrowser, launchStudioBrowser} from "../../dist/capture/browser.js";
import {renderRecipe} from "../../dist/capture/renderer.js";
import {loadProject} from "../../dist/config/load.js";
import {captureHostUpdateFields, openScene} from "../../dist/scenarios/runner.js";
import {startStudioServer} from "../../dist/server/server.js";
import {compileVariantTutorial, EMULATE_MENU, tutorialCamera} from "../../dist/tutorial/variant.js";

const exampleRoot = fileURLToPath(new URL("../../examples/basic-chat/", import.meta.url));

test("tutorial mode records the widget inside the editor replica with scripted UI state", {timeout: 180_000}, async (t) => {
  const detection = await detectBrowser();
  if (!detection.executablePath) {
    t.skip("No compatible local Chromium executable is installed; the Studio must not download one implicitly.");
    return;
  }
  const outputRoot = await mkdtemp(join(tmpdir(), "sws-tutorial-integration-"));
  t.after(() => rm(outputRoot, {recursive: true, force: true}));
  const project = await loadProject({inputDirectory: exampleRoot});
  const recipe = structuredClone(project.recipes.find((item) => item.id === "tutorial-setup").value);
  recipe.outputs.video.fps = 2;

  const result = await renderRecipe(project, recipe, {
    outputRoot,
    browserPath: detection.executablePath,
    allowIntermediate: true
  });
  assert.ok(result.status === "final" || result.status === "intermediate" || result.status === "unvalidated");
  const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
  const frames = JSON.parse(await readFile(join(outputRoot, manifest.artifacts[0].frames, "frames.json"), "utf8"));
  assert.equal(frames.frames.length, Math.round((recipe.outputs.video.durationMs * 2) / 1000));
  assert.equal(frames.width, 1920);
  assert.equal(frames.height, 1080);
  const hashes = new Set(frames.frames.map((frame) => frame.sha256));
  assert.ok(hashes.size > frames.frames.length / 2, "the scripted editor changes across the recording");
});

test("colorpicker steps open the md-color-picker dialog on stage and commit the exact value", {timeout: 180_000}, async (t) => {
  const detection = await detectBrowser();
  if (!detection.executablePath) {
    t.skip("No compatible local Chromium executable is installed; the Studio must not download one implicitly.");
    return;
  }
  const project = await loadProject({inputDirectory: exampleRoot});
  const scene = project.scenes.find((item) => item.id === "tutorial-editor").value;
  const base = project.recipes.find((item) => item.id === "tutorial-setup").value.outputs.video;
  const video = {
    ...base,
    tutorial: {
      ...base.tutorial,
      steps: [
        {action: "selectLayer"},
        {action: "chat", user: "Mira", text: "hi"},
        {action: "caption", text: "Pick an accent color and tune the opacity"},
        {action: "setField", field: "accentColor", value: "#ff7ad9"},
        {action: "wait", ms: 300}
      ]
    }
  };
  const timeline = compileVariantTutorial(project, {id: "color", scene}, video);
  const pickers = timeline.patches.filter((entry) => entry.patch.colorPicker).map((entry) => ({atMs: entry.atMs, ...entry.patch.colorPicker}));
  const openedAtMs = pickers[0].openedAtMs;
  const hueEnd = pickers.filter((state) => state.drag === "hue").at(-1).atMs;
  const spectrumEnd = pickers.filter((state) => state.drag === "spectrum").at(-1).atMs;
  const {hoverAtMs, closedAtMs} = pickers.at(-1);
  const commit = timeline.widget.find((action) => action.kind === "fields");
  const stateAt = (time) => pickers.filter((state) => state.atMs <= time).at(-1);

  const server = await startStudioServer(project, {port: 0, watch: false});
  const {browser} = await launchStudioBrowser({browserPath: detection.executablePath});
  t.after(async () => {
    await browser.close();
    await server.close();
  });
  const opened = await openScene(project, server, browser, scene, {
    host: "tutorial",
    camera: tutorialCamera(timeline),
    background: {id: "tutorial-editor", color: "transparent"}
  });
  t.after(() => opened.context.close());
  const {page} = opened;
  const setup = (output) => page.evaluate(
    (options) => window.__SWS_TUTORIAL__.setup(options),
    {timeline, menu: EMULATE_MENU, viewport: opened.resolved.viewport, output}
  );
  const renderAt = (timeMs) => page.evaluate((time) => {
    window.__SWS_TUTORIAL__.render(time);
    const box = (element) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height};
    };
    const cursor = document.querySelector("#se-cursor");
    const caption = document.querySelector("#se-caption");
    const strip = (name) => ({box: box(document.querySelector(`.se-cp-${name}`)), marker: box(document.querySelector(`.se-cp-${name} .mk`))});
    const [x, y] = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(cursor.style.transform).slice(1).map(Number);
    const size = Number.parseFloat(cursor.style.width);
    const hotspot = cursor.dataset.shape === "crosshair" ? [12, 12] : [5, 2.5];
    return {
      dialog: box(document.querySelector(".se-cp")),
      opacity: document.querySelector(".se-cp")?.style.opacity ?? null,
      backdrop: document.querySelector(".se-cp-backdrop")?.style.opacity ?? null,
      strips: {spectrum: strip("spectrum"), hue: strip("hue"), alpha: strip("alpha")},
      swatchTarget: box(document.querySelector('[data-target="swatch:accentColor"]')),
      selectHover: document.querySelectorAll(".se-cp-btn")[1]?.style.background ?? null,
      caption: caption.style.display === "none" ? null : {...box(caption), lines: Math.round((caption.offsetHeight - 28) / 29.7)},
      targets: Object.fromEntries(["hue", "spectrum", "alpha", "select"].map((name) => [name, box(document.querySelector(`[data-target="picker:${name}"]`))])),
      header: document.querySelector(".se-cp-value")?.textContent ?? null,
      field: document.querySelector(".se-field.color .value")?.textContent ?? null,
      swatch: document.querySelector(".se-field.color .swatch")?.style.background ?? null,
      tip: {x: x + (hotspot[0] * size) / 24, y: y + (hotspot[1] * size) / 24},
      shape: cursor.dataset.shape
    };
  }, timeMs);
  const inside = (rect, width, height) => rect && rect.width > 0 && rect.height > 0
    && rect.left >= 0 && rect.top >= 0 && rect.right <= width && rect.bottom <= height;
  const center = (rect) => ({x: rect.left + rect.width / 2, y: rect.top + rect.height / 2});
  // Each marker sits where md-color-picker puts it: spectrum at (s, 1 - v), hue at 1 - h/360, alpha at 1 - a.
  const assertMarkers = (frame, state, label) => {
    const unit = frame.strips.spectrum.box.width / 255;
    const offset = (name, axis) => (center(frame.strips[name].marker)[axis] - frame.strips[name].box[axis === "x" ? "left" : "top"]) / unit;
    const near = (actual, expected, what) =>
      assert.ok(Math.abs(actual - expected) <= 1, `${label}: ${what} marker at ${actual.toFixed(2)}px, expected ${expected.toFixed(2)}px`);
    near(offset("spectrum", "x"), state.s * 255, "spectrum x");
    near(offset("spectrum", "y"), (1 - state.v) * 255, "spectrum y");
    near(offset("hue", "y"), (1 - state.h / 360) * 255, "hue");
    near(offset("alpha", "y"), (1 - state.a) * 255, "alpha");
  };

  await setup(opened.resolved.output);
  for (let time = 0; time < openedAtMs; time += 250) await renderAt(time);
  const open = await renderAt(openedAtMs + 400);
  assert.equal(Number(open.opacity), 1);
  assert.ok(inside(open.dialog, 1920, 1080), `dialog on stage: ${JSON.stringify(open.dialog)}`);
  assert.ok(Math.abs(open.dialog.left + open.dialog.width / 2 - 960) < 1, "the dialog centers in the editor window, as $mdDialog does");
  for (const [name, rect] of Object.entries(open.targets)) assert.ok(inside(rect, 1920, 1080), `${name} target on stage: ${JSON.stringify(rect)}`);
  assert.equal(open.header, "#72f1b8");
  assert.equal(open.field, "#72f1b8");
  assertMarkers(open, stateAt(openedAtMs + 400), "open");
  assert.equal(open.caption.lines, 2, "the check needs a two-line caption");
  const scale = open.dialog.width / 347;
  assert.ok(
    open.caption.top >= open.dialog.bottom + 8 * scale || open.caption.bottom <= open.dialog.top - 8 * scale,
    `the caption stays clear of the dialog: caption ${JSON.stringify(open.caption)}, dialog ${JSON.stringify(open.dialog)}`
  );
  assert.ok(inside(open.caption, 1920, 1080), "the shifted caption stays on stage");

  for (let time = openedAtMs + 450; time < hueEnd; time += 100) await renderAt(time);
  const hued = await renderAt(hueEnd);
  assertMarkers(hued, stateAt(hueEnd), "hue drag end");
  const hueMarker = hued.targets.hue;
  assert.ok(Math.hypot(hued.tip.x - (hueMarker.left + hueMarker.width / 2), hued.tip.y - (hueMarker.top + hueMarker.height / 2)) < 2, "the cursor drags the hue marker");

  for (let time = hueEnd + 100; time < spectrumEnd; time += 100) await renderAt(time);
  const picked = await renderAt(spectrumEnd);
  assertMarkers(picked, stateAt(spectrumEnd), "spectrum drag end");
  assert.equal(picked.header, "#ff7ad9");
  const marker = picked.targets.spectrum;
  assert.ok(Math.hypot(picked.tip.x - (marker.left + marker.width / 2), picked.tip.y - (marker.top + marker.height / 2)) < 2, "the cursor drags the marker");
  assert.equal(picked.shape, "crosshair");
  assert.equal(picked.field, "#72f1b8", "the field changes only when Select commits");
  assert.equal(picked.swatch, "rgb(114, 241, 184)");

  const beforeHover = await renderAt(hoverAtMs - 1);
  assert.match(beforeHover.selectHover, /rgba\(158, 158, 158, 0\)/, "Select is not hovered before the cursor reaches it");
  const hovered = await renderAt(hoverAtMs);
  const select = hovered.targets.select;
  assert.ok(
    hovered.tip.x >= select.left && hovered.tip.x <= select.right && hovered.tip.y >= select.top && hovered.tip.y <= select.bottom,
    "the cursor is on Select when its hover starts"
  );

  // Closing: the dialog shrinks back toward the swatch and fades out before the value lands.
  const closing = await renderAt(closedAtMs + 200);
  assert.ok(Number(closing.opacity) > 0 && Number(closing.opacity) < 1, `dialog opacity mid-close: ${closing.opacity}`);
  assert.ok(closing.dialog.width < open.dialog.width && closing.dialog.height < open.dialog.height, "the dialog shrinks while closing");
  const distance = (rect) => Math.hypot(center(rect).x - center(open.swatchTarget).x, center(rect).y - center(open.swatchTarget).y);
  assert.ok(distance(closing.dialog) < distance(open.dialog), "the dialog heads back to the swatch");
  const closed = await renderAt(commit.atMs - 20);
  assert.ok(Number(closed.opacity) < 0.05, `dialog nearly gone before the commit: ${closed.opacity}`);
  assert.ok(Number(closed.backdrop) < 0.05, `backdrop nearly gone before the commit: ${closed.backdrop}`);
  assert.equal(closed.field, "#72f1b8");

  const done = await renderAt(commit.atMs);
  assert.equal(done.dialog, null);
  assert.equal(done.field, "#ff7ad9");
  assert.equal(done.swatch, "rgb(255, 122, 217)");
  assert.deepEqual(commit.fieldData, {accentColor: "#ff7ad9"});
  await captureHostUpdateFields(page, commit.fieldData);
  const accent = await opened.frame().evaluate(() => document.querySelector("#chat-widget").style.getPropertyValue("--accent"));
  assert.equal(accent, "#ff7ad9");

  // Every frame is a function of its time: sparse frame rates put the cursor where 30 fps does.
  const cursorTrack = async (fps) => {
    await setup(opened.resolved.output);
    return page.evaluate(({fps, endMs}) => {
      const track = {};
      for (let index = 0; index * 1000 / fps <= endMs; index += 1) {
        const time = Math.round((index * 1000) / fps);
        window.__SWS_TUTORIAL__.render(time);
        const cursor = document.querySelector("#se-cursor");
        track[time] = {transform: cursor.style.transform, width: cursor.style.width};
      }
      return track;
    }, {fps, endMs: timeline.endMs});
  };
  const dense = await cursorTrack(30);
  for (const fps of [5, 3, 2]) {
    const sparse = await cursorTrack(fps);
    for (const [time, frame] of Object.entries(sparse)) {
      const reference = dense[time];
      if (!reference) continue;
      const [x1, y1] = /translate\(([-\d.e]+)px, ([-\d.e]+)px\)/.exec(reference.transform).slice(1).map(Number);
      const [x2, y2] = /translate\(([-\d.e]+)px, ([-\d.e]+)px\)/.exec(frame.transform).slice(1).map(Number);
      assert.ok(Math.hypot(x1 - x2, y1 - y2) < 0.01, `${fps} fps cursor at ${time}ms is ${frame.transform}, 30 fps has ${reference.transform}`);
      assert.equal(frame.width, reference.width, `${fps} fps cursor shape at ${time}ms`);
    }
  }

  // A short editor scales the dialog down so the picker and its targets stay visible.
  await setup({width: 1920, height: 560});
  for (let time = 0; time < openedAtMs; time += 250) await renderAt(time);
  const short = await renderAt(openedAtMs + 400);
  assert.ok(inside(short.dialog, 1920, 560), `dialog in a 1920x560 editor: ${JSON.stringify(short.dialog)}`);
  for (const [name, rect] of Object.entries(short.targets)) assert.ok(inside(rect, 1920, 560), `${name} target in a short editor`);
});
