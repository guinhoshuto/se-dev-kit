import assert from "node:assert/strict";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import test from "node:test";

import {detectBrowser, launchStudioBrowser} from "../../dist/capture/browser.js";
import {renderRecipe} from "../../dist/capture/renderer.js";
import {loadProject} from "../../dist/config/load.js";
import {captureHostUpdateFields, openScene} from "../../dist/scenarios/runner.js";
import {startStudioServer} from "../../dist/server/server.js";
import {compileVariantTutorial, EMULATE_MENU, stillFrameIndex, tutorialCamera} from "../../dist/tutorial/variant.js";
import {createHash} from "node:crypto";

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
  const steps = recipe.outputs.video.tutorial.steps;
  steps.splice(steps.findIndex((step) => step.action === "selectLayer") + 1, 0, {action: "still", name: "layer-selected"});
  steps.unshift({action: "still", name: "start"});

  const result = await renderRecipe(project, recipe, {
    outputRoot,
    browserPath: detection.executablePath,
    allowIntermediate: true,
    // The 1.2 B/px upper bound puts this full-HD run near 160 MB; the test must not depend on this machine's free space.
    allowLowDisk: true,
    // This test once timed out after its last frame, under load, without saying where: now the log says.
    trace: (event) => t.diagnostic(`${event.at} +${event.elapsedMs} ms ${event.phase}${event.detail ? ` (${event.detail})` : ""}`)
  });
  assert.ok(result.status === "final" || result.status === "intermediate" || result.status === "unvalidated");
  const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
  const entry = manifest.artifacts[0];
  const frames = entry.frameSequence;
  assert.equal(entry.framesRetained, result.status !== "final", "frames are discarded only after a validated encode");
  if (entry.framesRetained) {
    assert.deepEqual(JSON.parse(await readFile(join(outputRoot, entry.frames, "frames.json"), "utf8")), frames);
  } else {
    assert.equal(entry.frames, null);
  }
  assert.equal(frames.frames.length, Math.round((recipe.outputs.video.durationMs * 2) / 1000));
  assert.equal(frames.width, 1920);
  assert.equal(frames.height, 1080);
  const hashes = new Set(frames.frames.map((frame) => frame.sha256));
  assert.ok(hashes.size > frames.frames.length / 2, "the scripted editor changes across the recording");

  // Each still is a byte copy of the frame it names, written next to the video and kept after the frames go.
  assert.deepEqual(entry.stills.map((still) => still.name), ["start", "layer-selected"]);
  assert.equal(entry.stills[0].atMs, 0);
  assert.ok(entry.stills[1].atMs > 0);
  for (const still of entry.stills) {
    assert.equal(still.frame, stillFrameIndex(still.atMs, 2, frames.frames.length));
    assert.equal(still.timestampMs, frames.frames[still.frame].timestampMs);
    assert.equal(still.file.file, `tutorial-setup/${entry.id}-still-${still.name}.png`);
    assert.deepEqual([still.file.width, still.file.height], [1920, 1080]);
    const bytes = await readFile(join(outputRoot, still.file.file));
    const digest = createHash("sha256").update(bytes).digest("hex");
    assert.equal(digest, still.file.sha256);
    assert.equal(digest, frames.frames[still.frame].sha256, `still ${still.name} is frame ${still.frame}`);
    assert.ok(result.artifacts.some((path) => path.endsWith(`/${still.file.file}`)), `still ${still.name} is an artifact`);
  }
  assert.notEqual(entry.stills[0].file.sha256, entry.stills[1].file.sha256, "the editor changed between the two stills");
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
      // This test asserts editor geometry (a dialog centered at 960 px); the camera is tested below.
      autoZoom: false,
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

test("the editor replica draws its UI in the vendored Nunito Sans and its chat in Inter, loaded before setup returns", {timeout: 180_000}, async (t) => {
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
    tutorial: {...base.tutorial, autoZoom: false, steps: [{action: "selectLayer"}, {action: "chat", user: "Mira", text: "hi"}, {action: "wait", ms: 300}]}
  };
  const timeline = compileVariantTutorial(project, {id: "fonts", scene}, video);
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

  // As setup returns, before any frame: both unicode ranges of both families are loaded, not only
  // the faces the first layout happened to need.
  const faces = await page.evaluate(async (options) => {
    await window.__SWS_TUTORIAL__.setup(options);
    const found = [];
    document.fonts.forEach((face) => found.push(`${face.family.replaceAll('"', "")} ${face.status}`));
    return found.sort();
  }, {timeline, menu: EMULATE_MENU, viewport: opened.resolved.viewport, output: opened.resolved.output});
  assert.deepEqual(faces, ["Inter Variable loaded", "Inter Variable loaded", "Nunito Sans Variable loaded", "Nunito Sans Variable loaded"]);

  // The fonts Chrome actually drew with, not the CSS stack: web fonts named Nunito Sans and Inter.
  await page.evaluate((time) => window.__SWS_TUTORIAL__.render(time), timeline.endMs - 1);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  const {root} = await cdp.send("DOM.getDocument", {depth: -1});
  const drawnWith = async (selector) => {
    const {nodeId} = await cdp.send("DOM.querySelector", {nodeId: root.nodeId, selector});
    assert.ok(nodeId, `${selector} exists`);
    return (await cdp.send("CSS.getPlatformFontsForNode", {nodeId})).fonts;
  };
  for (const [selector, family] of [["#se-toolbar .title", /^Nunito Sans/], ["#se-sidebar .se-section", /^Nunito Sans/], ["#se-chat .msg .name", /^Inter/]]) {
    const fonts = await drawnWith(selector);
    assert.ok(fonts.length > 0 && fonts.every((font) => font.isCustomFont && family.test(font.familyName)), `${selector}: ${JSON.stringify(fonts)}`);
  }

  // A replica without its font faces fails the setup instead of drawing in a fallback font.
  const refused = await page.evaluate(async (options) => {
    const style = document.querySelector("style");
    style.textContent = style.textContent.replace(/@font-face \{[^}]*\}/g, "");
    try {
      await window.__SWS_TUTORIAL__.setup(options);
      return "resolved";
    } catch (error) {
      return error.message;
    }
  }, {timeline, menu: EMULATE_MENU, viewport: opened.resolved.viewport, output: opened.resolved.output});
  assert.match(refused, /declares no Nunito Sans Variable or Inter Variable font face/);
});

test("an editor font the server does not deliver fails the tutorial setup, naming the fonts route", {timeout: 180_000}, async (t) => {
  const detection = await detectBrowser();
  if (!detection.executablePath) {
    t.skip("No compatible local Chromium executable is installed; the Studio must not download one implicitly.");
    return;
  }
  const project = await loadProject({inputDirectory: exampleRoot});
  const scene = project.scenes.find((item) => item.id === "tutorial-editor").value;
  const base = project.recipes.find((item) => item.id === "tutorial-setup").value.outputs.video;
  const video = {...base, tutorial: {...base.tutorial, autoZoom: false, steps: [{action: "selectLayer"}, {action: "wait", ms: 300}]}};
  const timeline = compileVariantTutorial(project, {id: "missing-font", scene}, video);
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
  // Latin Extended is never needed before setup, so its request is still ahead.
  await opened.page.route("**/__sws/ui/fonts/inter-latin-ext-wght-normal.woff2", (route) => route.fulfill({status: 404, body: ""}));
  const outcome = await opened.page.evaluate(async (options) => {
    try {
      await window.__SWS_TUTORIAL__.setup(options);
      return "resolved";
    } catch (error) {
      return error.message;
    }
  }, {timeline, menu: EMULATE_MENU, viewport: opened.resolved.viewport, output: opened.resolved.output});
  assert.match(outcome, /\(Inter Variable, U\+0?100-0?2BA.*\) failed to load from \/__sws\/ui\/fonts\//);
});

test("the sidebar scrolls every target into view before the pointer reaches it, in a group of 12 fields", {timeout: 180_000}, async (t) => {
  const detection = await detectBrowser();
  if (!detection.executablePath) {
    t.skip("No compatible local Chromium executable is installed; the Studio must not download one implicitly.");
    return;
  }
  // A synthetic widget: a Frame group of 12 fields of every kind the replica draws, then a Motion group below it.
  const root = await mkdtemp(join(tmpdir(), "sws-tutorial-scroll-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const text = (label) => ({type: "text", label, group: "Frame", value: label});
  const color = (label, value) => ({type: "colorpicker", label, group: "Frame", value});
  const slider = (label, group = "Frame") => ({type: "slider", label, group, value: 5, min: 0, max: 10, step: 1});
  const check = (label, group = "Frame") => ({type: "checkbox", label, group, value: true});
  const choice = (label) => ({type: "dropdown", label, group: "Frame", value: "solid", options: {solid: "Solid", outline: "Outline", glass: "Glass"}});
  const fields = {
    frameTitle: text("Frame title"), frameSubtitle: text("Subtitle"), frameColor: color("Frame color", "#20202a"), frameOpacity: slider("Opacity"),
    frameRadius: slider("Corner radius"), frameBorder: check("Border"), frameGlow: check("Glow"), frameAccent: color("Accent", "#ac96ff"),
    frameLabel: text("Label"), frameSize: choice("Size"), frameShadow: color("Shadow", "#000000"), frameBadge: choice("Badge"),
    motionSpeed: slider("Speed", "Motion"), motionLoop: check("Loop", "Motion")
  };
  await writeFile(join(root, "widget.html"), '<main id="widget">Frame</main>\n');
  await writeFile(join(root, "widget.css"), "#widget { width: 320px; height: 180px; background: #20202a; color: #fff; }\n");
  await writeFile(join(root, "widget.js"), "window.addEventListener('onWidgetLoad', () => {});\n");
  await writeFile(join(root, "widget.json"), `${JSON.stringify(fields)}\n`);
  await writeFile(join(root, "se-widget-studio.config.mjs"), 'export default {schemaVersion: 1, widget: {root: ".", files: {html: "widget.html", css: "widget.css", js: "widget.js", fields: "widget.json"}, viewport: {width: 430, height: 640}, ready: {selector: "#widget", timeoutMs: 10000}}, output: {root: "out"}};\n');
  const project = await loadProject({inputDirectory: root});
  const scene = {schemaVersion: 1, id: "editor", name: "Editor", viewport: {width: 430, height: 640}, output: {width: 1920, height: 1080, format: "png"}, captureAtMs: 0};
  const video = {
    enabled: true, mode: "tutorial", durationMs: 60_000, fps: 30, format: "mp4", codec: "h264", pixelFormat: "yuv420p", audio: "none",
    tutorial: {
      // This test asserts editor geometry; the camera has its own tests.
      autoZoom: false,
      steps: [
        {action: "selectLayer"},
        {action: "setField", field: "frameBadge", value: "outline"},
        // Save sits in the toolbar, above the scrolled sidebar: it must not scroll it.
        {action: "save"},
        {action: "setField", field: "frameSize", value: "glass"},
        {action: "setField", field: "frameShadow", value: "#ff7ad9"},
        {action: "setField", field: "frameTitle", value: "On air"},
        {action: "setField", field: "motionLoop", value: false}
      ]
    }
  };
  const timeline = compileVariantTutorial(project, {id: "scroll", scene}, video);
  const server = await startStudioServer(project, {port: 0, watch: false});
  const {browser} = await launchStudioBrowser({browserPath: detection.executablePath});
  t.after(async () => {
    await browser.close();
    await server.close();
  });
  const opened = await openScene(project, server, browser, scene, {
    host: "tutorial",
    camera: tutorialCamera(timeline),
    background: {id: "editor", color: "transparent"}
  });
  t.after(() => opened.context.close());
  const {page} = opened;
  await page.evaluate(
    (options) => window.__SWS_TUTORIAL__.setup(options),
    {timeline, menu: EMULATE_MENU, viewport: opened.resolved.viewport, output: opened.resolved.output}
  );

  // The pointer arrives 1 ms before each click: the target, and a field's label and control, are in view by then.
  const arrivals = await page.evaluate((moves) => moves.map(({to, endMs}) => {
    window.__SWS_TUTORIAL__.render(endMs - 1);
    const box = (element) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 ? {left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom} : null;
    };
    const target = [...document.querySelectorAll("#se-editor [data-target]")].find((element) => element.dataset.target === to && box(element));
    const sidebar = document.querySelector("#se-sidebar");
    const select = document.querySelector(".se-select-menu");
    const selected = select && to.startsWith("option:") ? document.querySelector(`[data-target="field:${to.split(":")[1]}"]`) : null;
    return {
      to,
      endMs,
      target: box(target),
      row: box(target?.closest(".se-field")),
      inSidebar: Boolean(target && sidebar.contains(target)),
      sidebar: box(sidebar),
      scrollTop: sidebar.scrollTop,
      stage: box(document.querySelector("#capture-stage")),
      editor: box(document.querySelector("#se-editor")),
      select: box(select),
      selectField: box(selected),
      picker: box(document.querySelector(".se-cp")),
      shape: document.querySelector("#se-cursor").dataset.shape
    };
  }), timeline.moves.filter((move) => typeof move.to === "string"));
  const inside = (rect, bounds) => rect && rect.left >= bounds.left - 0.5 && rect.top >= bounds.top - 0.5 && rect.right <= bounds.right + 0.5 && rect.bottom <= bounds.bottom + 0.5;
  for (const arrival of arrivals) {
    const label = `${arrival.to} at ${arrival.endMs} ms`;
    assert.ok(arrival.target, `${label}: the target is drawn`);
    assert.ok(inside(arrival.target, arrival.stage), `${label}: target ${JSON.stringify(arrival.target)} on the stage`);
    if (arrival.inSidebar) {
      assert.ok(inside(arrival.target, arrival.sidebar), `${label}: target ${JSON.stringify(arrival.target)} inside the sidebar ${JSON.stringify(arrival.sidebar)}`);
      if (arrival.row) assert.ok(inside(arrival.row, arrival.sidebar), `${label}: row ${JSON.stringify(arrival.row)} inside the sidebar ${JSON.stringify(arrival.sidebar)}`);
    }
    if (arrival.select) {
      assert.ok(inside(arrival.select, arrival.editor), `${label}: the select menu fits the editor`);
      assert.ok(arrival.selectField && arrival.select.top <= arrival.selectField.bottom && arrival.select.bottom >= arrival.selectField.top, `${label}: the select menu opens over its field`);
    }
    if (arrival.picker) assert.ok(inside(arrival.picker, arrival.editor), `${label}: the color picker fits the editor`);
  }
  // A target outside the sidebar (a popup, the chat) never scrolls it.
  arrivals.forEach((arrival, index) => {
    if (index > 0 && !arrival.inSidebar) assert.equal(arrival.scrollTop, arrivals[index - 1].scrollTop, `${arrival.to} at ${arrival.endMs} ms moved the sidebar`);
  });
  assert.ok(new Set(arrivals.map((arrival) => arrival.scrollTop)).size >= 3, `the sidebar scrolled down, back up, and down: ${arrivals.map((arrival) => arrival.scrollTop)}`);
  const scrolled = arrivals.filter((arrival) => arrival.to === "field:frameBadge" || arrival.to === "group:Motion");
  assert.equal(scrolled.length, 2, "the script reaches the last Frame field and the Motion header");
  assert.ok(arrivals.some((arrival) => arrival.to.startsWith("option:frameBadge")), "the Badge select opened");
  assert.ok(arrivals.some((arrival) => arrival.to === "picker:spectrum" && arrival.shape === "crosshair"), "the picker's spectrum still shows the crosshair");

  // A frame is a function of its time: drawn right after frame 0, each select menu still opens over its field.
  const options = arrivals.filter((arrival) => arrival.to.startsWith("option:"));
  assert.deepEqual(options.map((arrival) => arrival.to.split(":")[1]), ["frameBadge", "frameSize"]);
  for (const option of options) {
    const direct = await page.evaluate((time) => {
      window.__SWS_TUTORIAL__.render(0);
      window.__SWS_TUTORIAL__.render(time);
      const rect = document.querySelector(".se-select-menu").getBoundingClientRect();
      return {left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom};
    }, option.endMs - 1);
    assert.deepEqual(direct, option.select, option.to);
  }

  // With no popup open, the popup layer still spans the editor, and the pointer's hit test goes through it to the sidebar.
  const layer = await page.evaluate((time) => {
    window.__SWS_TUTORIAL__.render(time);
    const rect = (selector) => {
      const box = document.querySelector(selector).getBoundingClientRect();
      return [box.left, box.top, box.width, box.height].map(Math.round);
    };
    const field = document.querySelector("#se-sidebar .se-field, #se-sidebar .se-group").getBoundingClientRect();
    const hit = document.elementFromPoint(field.left + field.width / 2, field.top + field.height / 2);
    return {popup: rect("#se-popup-layer"), editor: rect("#se-editor"), hitInSidebar: document.querySelector("#se-sidebar").contains(hit)};
  }, arrivals.at(-1).endMs - 1);
  assert.deepEqual(layer.popup, layer.editor);
  assert.equal(layer.hitInSidebar, true);
});

test("auto zoom frames are a function of time and keep popups, captions, and the widget in view", {timeout: 300_000}, async (t) => {
  const detection = await detectBrowser();
  if (!detection.executablePath) {
    t.skip("No compatible local Chromium executable is installed; the Studio must not download one implicitly.");
    return;
  }
  const project = await loadProject({inputDirectory: exampleRoot});
  const scene = project.scenes.find((item) => item.id === "tutorial-editor").value;
  const video = project.recipes.find((item) => item.id === "tutorial-setup").value.outputs.video;
  const timeline = compileVariantTutorial(project, {id: "zoom", scene}, video);
  assert.deepEqual(timeline.autoZoom, {zoom: 1.8}, "the example keeps the default camera");
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
  const {width, height} = opened.resolved.output;
  const uiScale = timeline.chrome.uiScale;
  const probes = [];
  for (let time = 0; time <= timeline.endMs; time += 100) probes.push(time);

  // Renders `times` in order after a fresh setup and records the frames at `record` times.
  const pass = (times, record, crop = null) => page.evaluate(async ({options, times, record}) => {
    const host = window.__SWS_TUTORIAL__;
    await host.setup(options);
    const wanted = new Set(record);
    const box = (element) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 ? {left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom} : null;
    };
    const hull = (boxes) => {
      const present = boxes.filter(Boolean);
      if (present.length === 0) return null;
      return {
        left: Math.min(...present.map((item) => item.left)),
        top: Math.min(...present.map((item) => item.top)),
        right: Math.max(...present.map((item) => item.right)),
        bottom: Math.max(...present.map((item) => item.bottom))
      };
    };
    const frames = {};
    for (const time of times) {
      host.render(time);
      if (!wanted.has(time)) continue;
      const cursor = document.querySelector("#se-cursor");
      const caption = document.querySelector("#se-caption");
      const dialog = document.querySelector(".se-cp");
      const hue = [...document.querySelectorAll("[data-target]")].find((element) => element.dataset.target === "picker:hue");
      frames[time] = {
        camera: document.querySelector("#se-camera").style.transform,
        cursor: {transform: cursor.style.transform, width: cursor.style.width, shape: cursor.dataset.shape},
        caption: caption.style.transform,
        captionOpacity: caption.style.opacity,
        captionBox: caption.style.display === "none" ? null : {...box(caption), offsetHeight: caption.offsetHeight},
        editor: box(document.querySelector("#se-editor")),
        popups: [
          dialog && Number(dialog.style.opacity) === 1 ? box(dialog) : null,
          hull([".se-emu .live", ".se-emu .card", ".se-emu .sub"].map((selector) => box(document.querySelector(selector)))),
          box(document.querySelector(".se-select-menu"))
        ].filter(Boolean),
        widget: (() => {
          const widget = box(document.querySelector("#se-widget-box"));
          const canvas = box(document.querySelector("#se-canvas"));
          return widget && canvas
            ? {left: Math.max(widget.left, canvas.left), top: Math.max(widget.top, canvas.top), right: Math.min(widget.right, canvas.right), bottom: Math.min(widget.bottom, canvas.bottom)}
            : null;
        })(),
        hue: box(hue)
      };
    }
    return frames;
  }, {options: {timeline, menu: EMULATE_MENU, viewport: opened.resolved.viewport, output: opened.resolved.output, crop}, times, record});

  const grid = (fps) => {
    const times = [];
    for (let index = 0; (index * 1000) / fps <= timeline.endMs; index += 1) times.push(Math.round((index * 1000) / fps));
    return times;
  };
  const reverse = await pass([...probes].reverse(), probes);
  const tenFps = await pass(grid(10), probes);
  const thirtyFps = await pass(grid(30), probes);
  const parseCursor = (transform) => {
    const match = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/.exec(transform);
    assert.ok(match, `cursor transform ${transform}`);
    return match.slice(1).map(Number);
  };
  const zoomOf = (camera) => (camera === "none" ? 1 : Number(/scale\(([-\d.e]+)\)/.exec(camera)[1]));
  // The pointer is drawn at the camera's zoom: 28 editor px for the arrow, 24 for the crosshair.
  const cursorSize = (frame) => (frame.cursor.shape === "crosshair" ? 24 : 28) * uiScale * zoomOf(frame.camera);
  // Chrome reads a CSS length back with six significant digits (37.333…px as "37.3333px"), so a
  // pointer under 1000 px wide is within 0.0005 px of its size.
  const sizedWithCamera = (frame) => Math.abs(Number.parseFloat(frame.cursor.width) - cursorSize(frame)) < 0.001;
  let zoomed = 0;
  for (const time of probes) {
    const reference = tenFps[time];
    if (zoomOf(reference.camera) > 1.2) zoomed += 1;
    assert.ok(sizedWithCamera(reference),
      `the pointer is ${reference.cursor.width} wide at ${time} ms, not scaled with the camera ${reference.camera}`);
    for (const [label, other] of [["direct reverse seeks", reverse[time]], ["30 fps", thirtyFps[time]]]) {
      assert.equal(other.camera, reference.camera, `${label}: camera at ${time} ms`);
      assert.equal(other.caption, reference.caption, `${label}: caption at ${time} ms`);
      assert.equal(other.captionOpacity, reference.captionOpacity, `${label}: caption opacity at ${time} ms`);
      assert.equal(other.cursor.width, reference.cursor.width, `${label}: cursor size at ${time} ms`);
      const [x1, y1, s1] = parseCursor(reference.cursor.transform);
      const [x2, y2, s2] = parseCursor(other.cursor.transform);
      assert.ok(Math.hypot(x1 - x2, y1 - y2) < 0.01, `${label}: cursor at ${time} ms is ${other.cursor.transform}, 10 fps has ${reference.cursor.transform}`);
      assert.equal(s2, s1, `${label}: cursor pulse at ${time} ms`);
    }
  }
  assert.ok(zoomed > probes.length / 4, `the camera zooms in: ${zoomed} of ${probes.length} probes above 1.2x`);

  const inStage = (rect) => rect.left >= -1 && rect.top >= -1 && rect.right <= width + 1 && rect.bottom <= height + 1;
  const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  let popupFrames = 0;
  for (const time of probes) {
    const frame = tenFps[time];
    for (const popup of frame.popups) {
      popupFrames += 1;
      assert.ok(inStage(popup), `popup ${JSON.stringify(popup)} leaves the stage at ${time} ms (camera ${frame.camera})`);
      // A caption with no room beside a popup fades out rather than covering it.
      const faded = frame.captionOpacity !== "" && Number(frame.captionOpacity) === 0;
      if (frame.captionBox && !faded) assert.ok(!overlaps(popup, frame.captionBox), `the caption covers a popup at ${time} ms`);
    }
    if (frame.captionBox && frame.captionOpacity !== "") {
      assert.ok(Number(frame.captionOpacity) >= 0 && Number(frame.captionOpacity) < 1, `caption opacity ${frame.captionOpacity} at ${time} ms`);
    }
    if (frame.captionBox) {
      const drawn = frame.captionBox.bottom - frame.captionBox.top;
      assert.ok(Math.abs(drawn - frame.captionBox.offsetHeight * uiScale) <= uiScale, `caption scaled by the camera at ${time} ms: ${drawn}px tall`);
    }
  }
  assert.ok(popupFrames > 20, `popup frames checked: ${popupFrames}`);

  // The widget is in view whenever it reacts, and the pointer stays on the hue marker it drags.
  const reveals = [];
  for (const action of timeline.widget) for (let offset = 0; offset <= 500; offset += 100) reveals.push(action.atMs + offset);
  const hueMove = timeline.moves.find((move) => move.to === "picker:hue");
  const huePress = timeline.presses.find((press) => press.downMs === hueMove.endMs);
  const drags = [];
  for (let time = huePress.downMs + 50; time <= huePress.upMs; time += 50) drags.push(time);
  // The pointer itself pulses: 70 ms after a plain click it is pressed to 0.8 of its size.
  const pulses = timeline.presses.filter((press) => press.upMs === press.downMs).slice(0, 6).map((press) => press.downMs + 70);
  assert.ok(pulses.length >= 3, "the example has plain clicks");
  const seeks = [...new Set([...reveals, ...drags, ...pulses])].sort((left, right) => right - left);
  const direct = await pass(seeks, seeks);
  for (const time of pulses) {
    const scale = parseCursor(direct[time].cursor.transform)[2];
    assert.ok(Math.abs(scale - 0.8) < 1e-9, `the pointer is not pressed 70 ms after the click at ${time - 70} ms: ${direct[time].cursor.transform}`);
    assert.ok(sizedWithCamera(direct[time]), `pointer size at ${time} ms: ${direct[time].cursor.width}, camera ${direct[time].camera}`);
  }
  for (const time of reveals) {
    const {widget, camera} = direct[time];
    assert.ok(widget && inStage(widget), `widget ${JSON.stringify(widget)} out of view at ${time} ms (camera ${camera})`);
  }
  for (const time of drags) {
    const {cursor, hue, camera} = direct[time];
    assert.ok(zoomOf(camera) > 1.3, `the hue drag at ${time} ms is framed close: ${camera}`);
    const [x, y] = parseCursor(cursor.transform);
    const size = Number.parseFloat(cursor.width);
    const hotspot = cursor.shape === "crosshair" ? [12, 12] : [5, 2.5];
    const tip = {x: x + (hotspot[0] * size) / 24, y: y + (hotspot[1] * size) / 24};
    assert.ok(
      hue && tip.x >= hue.left - 0.5 && tip.x <= hue.right + 0.5 && tip.y >= hue.top - 0.5 && tip.y <= hue.bottom + 0.5,
      `the pointer ${JSON.stringify(tip)} leaves the hue marker ${JSON.stringify(hue)} at ${time} ms`
    );
  }

  // With a scene crop (here the canvas), the camera frames the crop: the editor covers it in every
  // frame, and the widget is inside it whenever it reacts.
  const crop = {x: 427, y: 0, width: 1040, height: 1080};
  const croppedTimes = [...new Set([...probes, ...reveals])].sort((left, right) => left - right);
  const cropped = await pass(croppedTimes, croppedTimes, crop);
  for (const time of croppedTimes) {
    const {editor, camera} = cropped[time];
    assert.ok(editor.left <= crop.x + 0.5 && editor.top <= crop.y + 0.5 && editor.right >= crop.x + crop.width - 0.5 && editor.bottom >= crop.y + crop.height - 0.5,
      `the crop shows past the editor at ${time} ms: ${JSON.stringify(editor)} (camera ${camera})`);
  }
  for (const time of reveals) {
    const {widget, camera} = cropped[time];
    assert.ok(widget && widget.left >= crop.x - 1 && widget.right <= crop.x + crop.width + 1 && widget.top >= crop.y - 1 && widget.bottom <= crop.y + crop.height + 1,
      `the widget ${JSON.stringify(widget)} leaves the crop at ${time} ms (camera ${camera})`);
  }
});
