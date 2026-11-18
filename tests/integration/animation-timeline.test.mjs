// The capture freezes the document timeline and finishes the animations its sampler moves past their end (#42).
// `page.clock` fakes timers, Date, performance and requestAnimationFrame, but not Chrome's document timeline:
// between two samples CSS animations, transitions and Web Animations moved on the real clock, so on a stalled
// machine an animation shorter than the stall ended for real and left `getAnimations()` before the sampler saw
// it. And a paused animation never resolves `finished` nor fires `finish`/`animationend`, so what a widget
// chained on its end never ran. The widgets react to a fixture event, after the capture froze the timeline.
import assert from "node:assert/strict";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

import {detectBrowser, launchStudioBrowser} from "../../dist/capture/browser.js";
import {loadProject} from "../../dist/config/load.js";
import {assertTimelineFrozen, captureHostDispatch, openScene, sampleFrameAnimations} from "../../dist/scenarios/runner.js";
import {startStudioServer} from "../../dist/server/server.js";

const realSleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
/** The value, or the error's code and message: a refusal is compared by assertion instead of failing the test as an exception. */
const outcome = (promise) => promise.then((value) => value, (error) => ({code: error.code, message: error.message}));

async function widget(t, {html = "", css = "", js = "", fields = {}, fieldUpdate}) {
  const root = await mkdtemp(join(tmpdir(), "sws-animation-timeline-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  await Promise.all([
    writeFile(join(root, "widget.html"), html),
    writeFile(join(root, "widget.css"), `html,body{margin:0;background:transparent}\n${css}`),
    writeFile(join(root, "widget.js"), js),
    writeFile(join(root, "widget.json"), JSON.stringify(fields))
  ]);
  const project = await loadProject({inputDirectory: root});
  if (fieldUpdate) project.config.widget.fieldUpdate = fieldUpdate;
  const viewport = {width: 200, height: 100};
  project.scenes.push({id: "still", filePath: "", value: {schemaVersion: 1, id: "still", name: "Still", viewport, output: {...viewport, format: "png"}, background: {id: "dark", color: "#10172b"}}});
  return project;
}

/** Opens the project's scene as every capture does; undefined (skipped) without a local Chromium. */
async function studio(t, project) {
  const detection = await detectBrowser();
  if (!detection.executablePath) {
    t.skip("No compatible local Chromium executable is installed; the Studio must not download one implicitly.");
    return undefined;
  }
  const {browser} = await launchStudioBrowser({browserPath: detection.executablePath});
  const server = await startStudioServer(project, {port: 0, watch: false});
  t.after(async () => {
    await browser.close();
    await server.close();
  });
  return async () => {
    const opened = await outcome(openScene(project, server, browser, project.scenes.find((item) => item.id === "still").value));
    if (opened.context) t.after(() => opened.context.close());
    return opened;
  };
}

/** Sets every document timeline of the page back to rate 1 through a CDP session of the test's own. */
async function runTimeline(page) {
  const session = await page.context().newCDPSession(page);
  await session.send("Animation.setPlaybackRate", {playbackRate: 1});
}

/** How far each frame's document timeline moves in `ms` of real time, by frame URL without its query. */
async function timelineDrift(page, ms = 50) {
  const read = () => Promise.all(page.frames().map((frame) => frame.evaluate(() => document.timeline.currentTime)));
  const before = await read();
  await realSleep(ms);
  const after = await read();
  return Object.fromEntries(page.frames().map((frame, index) => [frame === page.mainFrame() ? "host" : "widget", after[index] - before[index]]));
}

// Each event adds a box that fades in over 160 ms, with no fill: once it ends, the box is whole and the animation gone.
const FADE_WIDGET = {
  css: "@keyframes fade{from{opacity:0}to{opacity:1}}.pop{width:20px;height:20px;background:#fff;animation:fade 160ms linear}",
  js: `window.addEventListener("onEventReceived", () => {
  const box = document.createElement("div");
  box.className = "pop";
  document.body.append(box);
});`
};
const EVENT_MS = 100;
const STALL_MS = 400;

/** The capture's own steps around one event, with a 400 ms stall of real time after it: the opacity at the event and 80 and 160 ms later. */
async function fadeOpacities(opened) {
  const {page} = opened;
  const opacity = () => opened.frame().evaluate(() => Number(getComputedStyle(document.querySelector(".pop")).opacity));
  await page.clock.fastForward(EVENT_MS);
  await sampleFrameAnimations(page, EVENT_MS);
  await captureHostDispatch(page, "message", {data: {text: "hi"}});
  await realSleep(STALL_MS);
  await sampleFrameAnimations(page, EVENT_MS);
  const levels = [await opacity()];
  for (const step of [80, 160]) {
    await page.clock.fastForward(80);
    await sampleFrameAnimations(page, EVENT_MS + step);
    levels.push(await opacity());
  }
  return levels;
}

test("a 160 ms fade captured with a 400 ms stall starts at opacity 0 on the frozen timeline, and not on the real one", {timeout: 120_000}, async (t) => {
  const open = await studio(t, await widget(t, FADE_WIDGET));
  if (!open) return;

  const frozen = await open();
  assert.equal(frozen.code, undefined, `openScene failed: ${frozen.message}`);
  const levels = await fadeOpacities(frozen);
  t.diagnostic(`frozen: ${levels.join(" ")}`);
  assert.deepEqual(levels.map((level) => Math.round(level * 100) / 100), [0, 0.5, 1], "the fade's start, middle and end, at the sampled times");

  const real = await open();
  assert.equal(real.code, undefined, `openScene failed: ${real.message}`);
  await runTimeline(real.page);
  const realLevels = await fadeOpacities(real);
  t.diagnostic(`real: ${realLevels.join(" ")}`);
  assert.notEqual(realLevels[0], 0, "on the real timeline the fade ran during the stall");
});

test("the timeline check fails the capture with CAPTURE_TIMELINE_RUNNING when a frame's timeline runs", {timeout: 120_000}, async (t) => {
  const open = await studio(t, await widget(t, {html: '<div id="x">x</div>'}));
  if (!open) return;
  const opened = await open();
  assert.equal(opened.code, undefined, `openScene failed: ${opened.message}`);
  assert.equal(await outcome(assertTimelineFrozen(opened.page)), undefined, "frozen by openScene");

  await runTimeline(opened.page);
  const refused = await outcome(assertTimelineFrozen(opened.page));
  assert.equal(refused?.code, "CAPTURE_TIMELINE_RUNNING", JSON.stringify(refused));
  assert.match(refused.message, /\/__sws\/frame\/.* moved \d+\.\d ms/, "the message names the widget frame and how far it moved");
});

test("a field change that reloads the widget keeps the new frame's timeline frozen, and the frame renders", {timeout: 120_000}, async (t) => {
  const open = await studio(t, await widget(t, {
    html: '<div id="x">{{label}}</div>',
    fields: {label: {type: "text", label: "Label", value: "First"}},
    fieldUpdate: "reload"
  }));
  if (!open) return;
  const opened = await open();
  assert.equal(opened.code, undefined, `openScene failed: ${opened.message}`);
  const firstUrl = opened.frame().url();

  const update = await outcome(opened.updateFields({label: "Second"}));
  assert.equal(update.code, undefined, `updateFields failed: ${update.message}`);
  assert.notEqual(opened.frame().url(), firstUrl, "a new frame document");
  assert.deepEqual(await timelineDrift(opened.page), {host: 0, widget: 0});
  // A frame that renders no frames would hold its timeline too: at rate 1 this one runs.
  await runTimeline(opened.page);
  assert.ok((await timelineDrift(opened.page)).widget > 0, "the reloaded frame's timeline runs at rate 1");
});

// An entrance in Web Animations and in CSS chains on its end; a loop never ends; a reversed fade runs backwards.
const CHAIN_WIDGET = {
  html: '<div id="enter"></div><div id="css"></div><div id="loop"></div><div id="back"></div>',
  css: `div{width:10px;height:10px;background:#fff}
@keyframes rise{from{opacity:0}to{opacity:1}}
@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
#css.go{animation:rise 200ms linear forwards}
#loop.go{animation:spin 1000ms linear infinite}`,
  js: `window.chain = {finishes: 0, ends: 0, backFinished: false};
document.getElementById("css").addEventListener("animationend", () => { window.chain.ends += 1; });
window.addEventListener("onEventReceived", () => {
  const enter = document.getElementById("enter");
  const entrance = enter.animate([{opacity: 0}, {opacity: 1}], {duration: 200, fill: "forwards"});
  entrance.addEventListener("finish", () => { window.chain.finishes += 1; });
  entrance.finished.then(() => enter.classList.add("idle"));
  const back = document.getElementById("back").animate([{opacity: 0}, {opacity: 1}], {duration: 200, fill: "both"});
  back.reverse();
  back.finished.then(() => { window.chain.backFinished = true; });
  document.getElementById("css").classList.add("go");
  document.getElementById("loop").classList.add("go");
});`
};

test("an animation sampled at or past its end is finished once: its chain runs, a loop stays paused, a reversed one is not finished", {timeout: 120_000}, async (t) => {
  const open = await studio(t, await widget(t, CHAIN_WIDGET));
  if (!open) return;
  const opened = await open();
  assert.equal(opened.code, undefined, `openScene failed: ${opened.message}`);
  const {page} = opened;
  const state = async () => {
    // The finished promise, `finish` and `animationend` settle after the sample's task; 100 ms of real time covers them.
    await realSleep(100);
    return opened.frame().evaluate(() => {
      const [loop] = document.getElementById("loop").getAnimations();
      const [back] = document.getElementById("back").getAnimations();
      return {
        idle: document.getElementById("enter").classList.contains("idle"),
        finishes: window.chain.finishes,
        ends: window.chain.ends,
        loop: `${loop?.playState}@${loop?.currentTime}`,
        back: `${back?.playState}@${back?.currentTime}`,
        backFinished: window.chain.backFinished
      };
    });
  };
  const sampleAt = async (ms) => outcome(sampleFrameAnimations(page, ms));

  await sampleAt(0);
  await captureHostDispatch(page, "message", {data: {text: "go"}});
  await sampleAt(0);
  await sampleAt(100);
  assert.deepEqual(await state(), {idle: false, finishes: 0, ends: 0, loop: "paused@100", back: "paused@100", backFinished: false}, "before the end");

  assert.equal(await sampleAt(200), undefined, "the sample at the end does not throw");
  assert.deepEqual(await state(), {idle: true, finishes: 1, ends: 1, loop: "paused@200", back: "paused@200", backFinished: false}, "exactly at the end");

  for (const ms of [300, 400]) assert.equal(await sampleAt(ms), undefined, `the sample at ${ms} ms does not throw`);
  assert.deepEqual(await state(), {idle: true, finishes: 1, ends: 1, loop: "paused@400", back: "paused@400", backFinished: false}, "twice past the end");
});
