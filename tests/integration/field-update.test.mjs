// Stage 7 of docs/plans/google-fonts.md: `widget.fieldUpdate`. With `reload`, the default and what
// the StreamElements editor does, a field change recreates the widget frame: placeholders are
// substituted again and onWidgetLoad fires again. `event` keeps the frame and dispatches the Studio's
// onWidgetUpdate. Fonts come from the OFL fixture through route.fulfill; nothing reaches the network.
import assert from "node:assert/strict";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import test from "node:test";

import {detectBrowser, launchStudioBrowser} from "../../dist/capture/browser.js";
import {renderRecipe} from "../../dist/capture/renderer.js";
import {loadProject} from "../../dist/config/load.js";
import {checkOpenedFonts, frameEvents, openScene, runScenarios} from "../../dist/scenarios/runner.js";
import {DEFAULT_FIXED_TIME} from "../../dist/scenarios/state.js";
import {startStudioServer} from "../../dist/server/server.js";
import {compileVariantTutorial} from "../../dist/tutorial/variant.js";

const fixtures = fileURLToPath(new URL("../fixtures/fonts/", import.meta.url));
const FACES = {Alpha: await readFile(join(fixtures, "Unbounded-400.woff2")), Beta: await readFile(join(fixtures, "Unbounded-700.woff2"))};
const faceUrl = (family) => `https://fonts.gstatic.com/s/${family.toLowerCase()}/v1/face.woff2`;
const HANGING = "https://fonts.googleapis.com/css2?family=Hanging";
const EPOCH = Date.parse(DEFAULT_FIXED_TIME);

/** Google as the fixture knows it: Alpha and Beta, a stylesheet that never answers, 400 for the rest. */
async function fontRoute(url) {
  if (url === HANGING) return new Promise(() => {});
  const parsed = new URL(url);
  if (parsed.hostname === "fonts.googleapis.com") {
    const family = (parsed.searchParams.get("family") ?? "").split(":")[0];
    if (!Object.hasOwn(FACES, family)) return {status: 400, contentType: "text/html", body: Buffer.from("<!doctype html><title>Error 400</title>")};
    return {status: 200, contentType: "text/css", body: Buffer.from(`@font-face{font-family:'${family}';font-style:normal;font-weight:400;src:url(${faceUrl(family)}) format('woff2')}`)};
  }
  const family = Object.keys(FACES).find((name) => url === faceUrl(name));
  return family ? {status: 200, contentType: "font/woff2", body: FACES[family]} : undefined;
}

async function browserPath(t) {
  const detection = await detectBrowser();
  if (!detection.executablePath) t.skip("No compatible local Chromium executable is installed; the Studio must not download one implicitly.");
  return detection.executablePath;
}

async function widget(t, {html, css = "", js = "", fields, fieldUpdate, ready, viewport = {width: 320, height: 120}}) {
  const root = await mkdtemp(join(tmpdir(), "sws-field-update-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  await Promise.all([
    writeFile(join(root, "widget.html"), html),
    writeFile(join(root, "widget.css"), `html,body{margin:0;background:transparent}\n${css}`),
    writeFile(join(root, "widget.js"), js),
    writeFile(join(root, "widget.json"), JSON.stringify(fields))
  ]);
  const project = await loadProject({inputDirectory: root});
  if (fieldUpdate) project.config.widget.fieldUpdate = fieldUpdate;
  if (ready) project.config.widget.ready = ready;
  project.scenes.push({id: "still", filePath: "", value: {schemaVersion: 1, id: "still", name: "Still", viewport, output: {...viewport, format: "png"}, background: {id: "dark", color: "#10172b"}}});
  return project;
}

async function openStill(t, project) {
  const executablePath = await browserPath(t);
  if (!executablePath) return undefined;
  const {browser} = await launchStudioBrowser({browserPath: executablePath});
  const server = await startStudioServer(project, {port: 0, watch: false});
  t.after(async () => {
    await browser.close();
    await server.close();
  });
  const opened = await openScene(project, server, browser, project.scenes.find((item) => item.id === "still").value, {fontRoute});
  t.after(() => opened.context.close());
  return opened;
}

// Reads the family and the label only in onWidgetLoad, and through {{placeholders}}, like most store widgets.
const PLACEHOLDER_WIDGET = {
  html: `<link id="gf" rel="stylesheet" href="https://fonts.googleapis.com/css2?family={{font}}"><h1 id="t" style="font-family:'{{font}}'">{{label}}</h1>`,
  css: "h1{margin:0;padding:24px 12px;font-size:40px;line-height:1;color:#fff}",
  js: `window.loads = 0;
window.updates = [];
window.addEventListener("onWidgetLoad", (event) => { window.loads += 1; window.loaded = event.detail.fieldData; });
window.addEventListener("onWidgetUpdate", (event) => { window.updates.push(event.detail.fieldData); });`,
  fields: {font: {type: "googleFont", label: "Font", value: "Alpha"}, label: {type: "text", label: "Label", value: "First"}}
};

const frameState = (opened) => opened.frame().evaluate(() => ({
  marked: window.marked,
  loads: window.loads,
  updates: window.updates,
  loaded: window.loaded,
  text: document.getElementById("t").textContent,
  href: document.getElementById("gf").href,
  faces: [...document.fonts].filter((face) => face.status === "loaded").map((face) => face.family.replace(/["']/g, ""))
}));

test("reload, the default: a field change recreates the frame, substitutes placeholders again, fires onWidgetLoad, and settles the new family", {timeout: 120_000}, async (t) => {
  const opened = await openStill(t, await widget(t, PLACEHOLDER_WIDGET));
  if (!opened) return;
  assert.equal(opened.fieldUpdate, "reload");
  await opened.frame().evaluate(() => { window.marked = true; });

  const update = await opened.updateFields({font: "Beta", label: "Second"});
  assert.equal(update.virtualMs, 0, "without a ready selector the reload takes no virtual time");
  assert.equal(update.fonts.families.find((entry) => entry.family === "Beta")?.status, "loaded", JSON.stringify(update.fonts.families));
  const state = await frameState(opened);
  assert.equal(state.marked, undefined, "a new document");
  assert.equal(state.loads, 1);
  assert.deepEqual(state.updates, []);
  assert.equal(state.loaded.font, "Beta");
  assert.equal(state.text, "Second", "the HTML placeholder has the new value");
  assert.match(state.href, /family=Beta$/);
  assert.ok(state.faces.includes("Beta"), `loaded faces: ${state.faces.join(", ")}`);

  // A later change keeps the values set before it.
  await opened.updateFields({label: "Third"});
  const later = await frameState(opened);
  assert.deepEqual([later.text, later.loaded.font], ["Third", "Beta"]);
  assert.deepEqual(opened.issues.errors, []);
});

test("event: a field change keeps the frame and dispatches onWidgetUpdate with the merged values", {timeout: 120_000}, async (t) => {
  const opened = await openStill(t, await widget(t, {...PLACEHOLDER_WIDGET, fieldUpdate: "event"}));
  if (!opened) return;
  assert.equal(opened.fieldUpdate, "event");
  await opened.frame().evaluate(() => { window.marked = true; });

  const update = await opened.updateFields({label: "Second"});
  assert.equal(update.virtualMs, 0);
  const state = await frameState(opened);
  assert.equal(state.marked, true, "the same document");
  assert.equal(state.loads, 1);
  assert.deepEqual(state.updates.map(({font, label}) => ({font, label})), [{font: "Alpha", label: "Second"}]);
  assert.equal(state.text, "First", "placeholders keep the values the frame loaded with");
});

test("requests the replaced document still had in flight are not failures of the widget", {timeout: 120_000}, async (t) => {
  const opened = await openStill(t, await widget(t, PLACEHOLDER_WIDGET));
  if (!opened) return;
  // A Google stylesheet whose answer is still pending when the field changes: the reload aborts it.
  await opened.frame().evaluate((href) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    document.head.append(link);
  }, HANGING);
  const started = Date.now();
  while (!opened.issues.pendingFonts.has(HANGING)) {
    assert.ok(Date.now() - started < 10_000, "the stylesheet request started");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  const update = await opened.updateFields({label: "Second"});
  assert.deepEqual(opened.issues.fonts, [], "the aborted request is the reload's doing");
  assert.deepEqual(opened.issues.errors, []);
  assert.deepEqual(checkOpenedFonts(opened, update.fonts).warnings, []);
});

test("a runtime error of the replaced frame still counts after the reload", {timeout: 120_000}, async (t) => {
  const opened = await openStill(t, await widget(t, {
    html: "<h1 id=\"t\">{{label}}</h1>",
    js: 'window.addEventListener("onWidgetLoad", ({detail}) => { if (detail.fieldData.label === "First") setTimeout(() => Promise.reject(new Error("late failure in the first frame")), 0); });',
    fields: {label: {type: "text", label: "Label", value: "First"}}
  }));
  if (!opened) return;
  const failed = async () => (await frameEvents(opened.page)).some((event) => event.type === "frame:unhandled-rejection" && event.payload?.message === "Error: late failure in the first frame");
  await opened.page.clock.fastForward(1);
  const started = Date.now();
  while (!(await failed())) {
    assert.ok(Date.now() - started < 10_000, "the first frame reported its unhandled rejection");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  await opened.updateFields({label: "Second"});
  assert.ok(await failed(), "the capture still reports it, so the render or test fails as it would without the reload");
});

test("a reload whose ready selector needs the widget's timers reports that virtual time, and the new frame's clock goes on from it", {timeout: 120_000}, async (t) => {
  const opened = await openStill(t, await widget(t, {
    html: "<h1 id=\"t\">{{label}}</h1>",
    js: 'window.addEventListener("onWidgetLoad", () => setTimeout(() => { const ready = document.createElement("i"); ready.id = "ready"; document.body.append(ready); }, 40));',
    fields: {label: {type: "text", label: "Label", value: "First"}},
    ready: {selector: "#ready", timeoutMs: 2_000}
  }));
  if (!opened) return;
  const elapsed = () => opened.frame().evaluate((epoch) => Date.now() - epoch, EPOCH);
  assert.equal(await elapsed(), 0);
  await opened.page.clock.fastForward(500);
  assert.equal(await elapsed(), 500);
  const update = await opened.updateFields({label: "Second"});
  assert.equal(update.virtualMs, 48, "three 16 ms steps pass the widget's 40 ms timer");
  assert.equal(await elapsed(), 548);
  assert.equal(await opened.frame().evaluate(() => document.getElementById("t").textContent), "Second");
});

test("scenario updateFields follows the mode: a widget that reads fields only on load passes with reload and fails with event", {timeout: 120_000}, async (t) => {
  const executablePath = await browserPath(t);
  if (!executablePath) return;
  for (const fieldUpdate of ["reload", "event"]) {
    // No Google Fonts: a local scenario run has no font package, so it blocks them.
    const project = await widget(t, {
      html: '<h1 id="t"></h1>',
      js: 'window.addEventListener("onWidgetLoad", ({detail}) => { document.getElementById("t").textContent = detail.fieldData.label; });',
      fields: {label: {type: "text", label: "Label", value: "First"}},
      fieldUpdate
    });
    project.scenarios.push({id: "rename", filePath: "", value: {schemaVersion: 1, id: "rename", name: "Rename", scene: "still", steps: [
      {action: "updateFields", fieldData: {label: "Renamed"}},
      {action: "assert", selector: "#t", text: "Renamed"}
    ]}});
    const {results} = await runScenarios(project, {browserPath: executablePath});
    assert.equal(results[0].status, fieldUpdate === "reload" ? "passed" : "failed", `${fieldUpdate}: ${JSON.stringify(results[0].errors)}`);
  }
});

/** Counts, per color, the pixels of a PNG that have exactly that RGB. Decoded by the browser, like the frames. */
async function colorCounts(page, png, colors) {
  return page.evaluate(async ({data, wanted}) => {
    const image = new Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();
    const canvas = new OffscreenCanvas(image.width, image.height);
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, image.width, image.height).data;
    const counts = wanted.map(() => 0);
    for (let index = 0; index < pixels.length; index += 4) {
      for (let color = 0; color < wanted.length; color += 1) {
        const [red, green, blue] = wanted[color];
        if (pixels[index] === red && pixels[index + 1] === green && pixels[index + 2] === blue) counts[color] += 1;
      }
    }
    return counts;
  }, {data: png.toString("base64"), wanted: colors});
}

// Paints its own clock (milliseconds since the capture time, as red and green) and the tone field.
// It reads the tone only in onWidgetLoad, and its ready element needs 40 ms of its own timers.
const CLOCK_WIDGET = {
  html: '<div id="clock"></div><div id="tone"></div>',
  css: "#clock,#tone{position:absolute;top:0;width:200px;height:300px}#clock{left:0}#tone{left:200px}",
  js: `function paint() {
  const t = Math.max(0, Date.now() - ${EPOCH});
  document.getElementById("clock").style.background = "rgb(" + (t & 255) + "," + ((t >> 8) & 255) + ",7)";
  requestAnimationFrame(paint);
}
window.addEventListener("onWidgetLoad", ({detail}) => {
  document.getElementById("tone").style.background = detail.fieldData.tone;
  paint();
  setTimeout(() => { const ready = document.createElement("i"); ready.id = "ready"; document.body.append(ready); }, 40);
});`,
  fields: {tone: {type: "text", label: "Tone", value: "#102030"}},
  ready: {selector: "#ready", timeoutMs: 2_000},
  viewport: {width: 400, height: 300}
};
const OLD_TONE = [0x10, 0x20, 0x30];
const NEW_TONE = [0x40, 0x50, 0x60];
const clockColor = (timeMs) => [timeMs & 255, (timeMs >> 8) & 255, 7];
// The blocks cover 200×300 px; a match this large cannot be the editor replica by chance.
const BLOCK = 20_000;

async function renderTutorial(t, executablePath, fieldUpdate) {
  const project = await widget(t, {...CLOCK_WIDGET, fieldUpdate});
  const scene = {schemaVersion: 1, id: "tutorial", name: "Tutorial", viewport: CLOCK_WIDGET.viewport, output: {width: 1920, height: 1080, format: "png"}, captureAtMs: 0};
  project.scenes.push({id: scene.id, filePath: "", value: scene});
  const video = {
    // Long enough to compile the script; the render below lasts just past its end.
    enabled: true, mode: "tutorial", durationMs: 600_000, fps: 10, format: "mp4", codec: "h264", pixelFormat: "yuv420p", audio: "none", keepFrames: true,
    tutorial: {widget: {x: 960, y: 540, scale: 1}, autoZoom: false, steps: [{action: "selectLayer"}, {action: "setField", field: "tone", value: "#405060"}, {action: "wait", ms: 600}]}
  };
  const timeline = compileVariantTutorial(project, {id: "tutorial", scene}, video);
  video.durationMs = Math.ceil((timeline.endMs + 200) / 100) * 100;
  const change = timeline.widget.find((action) => action.kind === "fields");
  assert.deepEqual(change.fieldData, {tone: "#405060"});
  const outputRoot = await mkdtemp(join(tmpdir(), "sws-field-update-out-"));
  t.after(() => rm(outputRoot, {recursive: true, force: true}));
  const result = await renderRecipe(project, {schemaVersion: 1, id: "tutorial", name: "Tutorial", scenes: ["tutorial"], outputs: {screenshots: false, video}}, {
    outputRoot,
    browserPath: executablePath,
    ffmpegPath: join(outputRoot, "missing-ffmpeg"),
    allowIntermediate: true,
    allowLowDisk: true
  });
  const entry = JSON.parse(await readFile(result.manifestPath, "utf8")).artifacts[0];
  const frames = await Promise.all(entry.frameSequence.frames.map(async (frame) => ({timestampMs: frame.timestampMs, png: await readFile(join(outputRoot, entry.frames, frame.file))})));
  return {atMs: change.atMs, entry, frames};
}

test("a tutorial setField on a widget that reads fields only on load: reload shows the value from the first frame after atMs, and the widget's clock equals every frame's timestamp", {timeout: 300_000}, async (t) => {
  const executablePath = await browserPath(t);
  if (!executablePath) return;
  const reload = await renderTutorial(t, executablePath, undefined);
  // The same video in event mode: the widget never sees the change, which is why reload is the default.
  const event = await renderTutorial(t, executablePath, "event");
  // One Chrome at a time: the frames are decoded after both renders closed theirs.
  const {browser} = await launchStudioBrowser({browserPath: executablePath});
  t.after(() => browser.close());
  const page = await browser.newPage();

  assert.deepEqual(reload.entry.fieldUpdate, {mode: "reload", updates: [{atMs: reload.atMs, virtualMs: 48}]});
  const settled = reload.atMs + 48 + 1;
  let before = 0;
  let after = 0;
  for (const frame of reload.frames) {
    if (frame.timestampMs === 0) continue;
    const [clock, oldTone, newTone] = await colorCounts(page, frame.png, [clockColor(frame.timestampMs), OLD_TONE, NEW_TONE]);
    const at = `frame at ${frame.timestampMs} ms (the field changes at ${reload.atMs} ms)`;
    if (frame.timestampMs < reload.atMs) {
      before += 1;
      assert.ok(oldTone > BLOCK && newTone === 0, `${at}: old tone ${oldTone} px, new tone ${newTone} px`);
    } else {
      after += 1;
      assert.ok(newTone > BLOCK && oldTone === 0, `${at}: new tone ${newTone} px, old tone ${oldTone} px`);
    }
    if (frame.timestampMs < reload.atMs || frame.timestampMs > settled) assert.ok(clock > BLOCK, `${at}: the widget's clock is not ${frame.timestampMs} ms (${clock} px)`);
  }
  assert.ok(before >= 3 && after >= 3, `${before} frames before the change, ${after} after`);

  assert.deepEqual(event.entry.fieldUpdate, {mode: "event", updates: [{atMs: event.atMs, virtualMs: 0}]});
  for (const frame of event.frames) {
    if (frame.timestampMs === 0) continue;
    const [clock, oldTone, newTone] = await colorCounts(page, frame.png, [clockColor(frame.timestampMs), OLD_TONE, NEW_TONE]);
    assert.ok(oldTone > BLOCK && newTone === 0, `event mode, frame at ${frame.timestampMs} ms: old tone ${oldTone} px, new tone ${newTone} px`);
    assert.ok(clock > BLOCK, `event mode, frame at ${frame.timestampMs} ms: the widget's clock is off (${clock} px)`);
  }
});
