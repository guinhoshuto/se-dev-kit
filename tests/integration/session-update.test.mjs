// The frame runtime keeps StreamElements session data: onWidgetLoad delivers it as
// `detail.session.data`, and every event the Session Dashboard counts updates it and fires
// onSessionUpdate with `detail.session`, after onEventReceived.
import assert from "node:assert/strict";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

import {detectBrowser, launchStudioBrowser} from "../../dist/capture/browser.js";
import {loadProject} from "../../dist/config/load.js";
import {captureHostDispatch, openScene} from "../../dist/scenarios/runner.js";
import {startStudioServer} from "../../dist/server/server.js";

const WIDGET_JS = `window.order = [];
window.updates = [];
window.addEventListener("onWidgetLoad", (event) => { window.loaded = event.detail.session.data; });
window.addEventListener("onEventReceived", (event) => { window.order.push("event:" + event.detail.listener); });
window.addEventListener("onSessionUpdate", (event) => { window.order.push("session"); window.updates.push(event.detail.session); });`;

test("onWidgetLoad delivers the fixture's session data over the defaults, and counted events fire onSessionUpdate after onEventReceived", {timeout: 120_000}, async (t) => {
  const detection = await detectBrowser();
  if (!detection.executablePath) {
    t.skip("No compatible local Chromium executable is installed; the Studio must not download one implicitly.");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "sws-session-update-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  await Promise.all([
    writeFile(join(root, "widget.html"), "<div id=\"goal\"></div>"),
    writeFile(join(root, "widget.css"), "html,body{margin:0;background:transparent}"),
    writeFile(join(root, "widget.js"), WIDGET_JS),
    writeFile(join(root, "widget.json"), "{}")
  ]);
  const project = await loadProject({inputDirectory: root});
  project.fixtures.push({id: "night", filePath: "", value: {
    schemaVersion: 1, id: "night", name: "Night", events: [],
    session: {"tip-session": {amount: 5}, "tip-session-top-donator": {name: "Ana", amount: 20}}
  }});
  const viewport = {width: 200, height: 100};
  const scene = {schemaVersion: 1, id: "still", name: "Still", fixture: "night", viewport, output: {...viewport, format: "png"}, background: {id: "dark", color: "#10172b"}};
  const {browser} = await launchStudioBrowser({browserPath: detection.executablePath});
  const server = await startStudioServer(project, {port: 0, watch: false});
  t.after(async () => {
    await browser.close();
    await server.close();
  });
  const opened = await openScene(project, server, browser, scene);
  t.after(() => opened.context.close());
  const frame = () => opened.frame().evaluate(() => ({loaded: window.loaded, order: window.order, updates: window.updates}));

  const before = await frame();
  assert.deepEqual(before.loaded["tip-session"], {amount: 5}, "the fixture's key");
  assert.deepEqual(before.loaded["follower-total"], {count: 0}, "a default key");
  assert.deepEqual(before.updates, []);

  await captureHostDispatch(opened.page, "tip-latest", {name: "Bo", amount: 15, message: "hi"});
  await captureHostDispatch(opened.page, "message", {data: {text: "hello"}});
  await captureHostDispatch(opened.page, "tip-latest", {name: "Bo", amount: 10, message: ""});
  const after = await frame();
  assert.deepEqual(after.order, ["event:tip-latest", "session", "event:message", "event:tip-latest", "session"], "a chat message updates no session");
  const [first, second] = after.updates;
  assert.deepEqual(first["tip-latest"], {name: "Bo", amount: 15, message: "hi"});
  assert.deepEqual(first["tip-session"], {amount: 20});
  assert.deepEqual(first["tip-session-top-donator"], {name: "Ana", amount: 20}, "Bo's 15 does not pass Ana's 20");
  assert.deepEqual(second["tip-session"], {amount: 30});
  assert.deepEqual(second["tip-session-top-donator"], {name: "Bo", amount: 25}, "Bo's two tips add up");
  assert.deepEqual(second["tip-session-top-donation"], {name: "Bo", amount: 15});
  assert.equal(second["tip-count"].count, 2);
});

test("a reload for a field change starts the new frame from the session data so far, and resetSession from the fixture's", {timeout: 120_000}, async (t) => {
  const detection = await detectBrowser();
  if (!detection.executablePath) {
    t.skip("No compatible local Chromium executable is installed; the Studio must not download one implicitly.");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "sws-session-reload-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  await Promise.all([
    writeFile(join(root, "widget.html"), "<div id=\"goal\"></div>"),
    writeFile(join(root, "widget.css"), "html,body{margin:0;background:transparent}"),
    writeFile(join(root, "widget.js"), WIDGET_JS),
    writeFile(join(root, "widget.json"), JSON.stringify({label: {type: "text", label: "Label", value: "First"}}))
  ]);
  const project = await loadProject({inputDirectory: root});
  assert.equal(project.config.widget.fieldUpdate ?? "reload", "reload");
  project.fixtures.push({id: "night", filePath: "", value: {
    schemaVersion: 1, id: "night", name: "Night", events: [],
    session: {"tip-session": {amount: 5}}
  }});
  const viewport = {width: 200, height: 100};
  const scene = {schemaVersion: 1, id: "still", name: "Still", fixture: "night", viewport, output: {...viewport, format: "png"}, background: {id: "dark", color: "#10172b"}};
  const {browser} = await launchStudioBrowser({browserPath: detection.executablePath});
  const server = await startStudioServer(project, {port: 0, watch: false});
  t.after(async () => {
    await browser.close();
    await server.close();
  });
  const opened = await openScene(project, server, browser, scene);
  t.after(() => opened.context.close());
  const loaded = () => opened.frame().evaluate(() => window.loaded);

  await captureHostDispatch(opened.page, "tip-latest", {name: "Bo", amount: 15, message: "hi"});
  await opened.updateFields({label: "Second"});
  const reloaded = await loaded();
  assert.deepEqual(reloaded["tip-session"], {amount: 20}, "the fixture's 5 and the tip's 15");
  assert.deepEqual(reloaded["tip-latest"], {name: "Bo", amount: 15, message: "hi"});
  assert.equal(reloaded["tip-recent"].length, 1);

  // The new frame counts on from there, and a second reload keeps that too.
  await captureHostDispatch(opened.page, "tip-latest", {name: "Cy", amount: 10, message: ""});
  await opened.updateFields({label: "Third"});
  assert.deepEqual((await loaded())["tip-session"], {amount: 30});

  await opened.page.evaluate(async () => {
    window.__SWS_CAPTURE__.reload({fieldData: {label: "First"}, resetSession: true});
    await window.__SWS_CAPTURE__.reloaded();
  });
  const reset = await loaded();
  assert.deepEqual(reset["tip-session"], {amount: 5}, "resetSession starts from the fixture again");
  assert.deepEqual(reset["tip-recent"], []);
  assert.deepEqual(opened.issues.errors, []);
});
