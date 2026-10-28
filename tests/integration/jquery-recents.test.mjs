// StreamElements' custom widget frame loads jQuery 3.3.1 in its <head>, before the widget's HTML and
// JS, and passes onWidgetLoad's `recents` as an array. The frame runtime loads the vendored copy
// before any widget script and passes the fixture's array; a stored fixture's legacy `{}` reads as [].
import assert from "node:assert/strict";
import {mkdtemp, mkdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

import {detectBrowser, launchStudioBrowser} from "../../dist/capture/browser.js";
import {loadFixtures} from "../../dist/config/catalog.js";
import {loadProject} from "../../dist/config/load.js";
import {frameEvents, openScene} from "../../dist/scenarios/runner.js";
import {startStudioServer} from "../../dist/server/server.js";

// An inline script in the HTML runs before the widget JS, as in StreamElements; both use `$`. jQuery 3
// runs a `$(fn)` callback from a timer, which a capture's paused clock runs once it advances.
const WIDGET_HTML = `<ul id="list"></ul>
<script>window.htmlSawJquery = typeof $ === "function" && $ === jQuery; $(() => { window.readyRan = true; });</script>`;
const WIDGET_JS = `window.addEventListener("onWidgetLoad", (obj) => {
  const recents = obj.detail.recents;
  window.loaded = {isArray: Array.isArray(recents), count: recents.length};
  recents.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const event of recents) $("#list").append($("<li>").text(event.name));
});`;
const RECENTS = [
  {type: "follower", name: "Cy", createdAt: "2025-01-15T11:58:00.000Z"},
  {type: "tip", name: "Ana", amount: 5, createdAt: "2025-01-15T11:50:00.000Z"},
  {type: "follower", name: "Bo", createdAt: "2025-01-15T11:55:00.000Z"}
];

test("the widget frame loads jQuery 3.3.1 before the widget's HTML scripts, and onWidgetLoad gets the fixture's recents as an array", {timeout: 120_000}, async (t) => {
  const detection = await detectBrowser();
  if (!detection.executablePath) {
    t.skip("No compatible local Chromium executable is installed; the Studio must not download one implicitly.");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "sws-jquery-recents-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(join(root, "fixtures"));
  await Promise.all([
    writeFile(join(root, "widget.html"), WIDGET_HTML),
    writeFile(join(root, "widget.css"), "html,body{margin:0;background:transparent}"),
    writeFile(join(root, "widget.js"), WIDGET_JS),
    writeFile(join(root, "widget.json"), "{}"),
    writeFile(join(root, "fixtures", "recent.json"), JSON.stringify({schemaVersion: 1, id: "recent", name: "Recent", recents: RECENTS, events: []})),
    // Older fixtures and immutable stored revisions wrote recents as an object.
    writeFile(join(root, "fixtures", "legacy.json"), JSON.stringify({schemaVersion: 1, id: "legacy", name: "Legacy", recents: {}, events: []}))
  ]);
  const project = await loadProject({inputDirectory: root});
  project.fixtures.push(...(await loadFixtures(root, "fixtures/*.json")));
  const viewport = {width: 200, height: 100};
  const scene = (fixture) => ({schemaVersion: 1, id: fixture, name: fixture, fixture, viewport, output: {...viewport, format: "png"}, background: {id: "dark", color: "#10172b"}});
  const {browser} = await launchStudioBrowser({browserPath: detection.executablePath});
  const server = await startStudioServer(project, {port: 0, watch: false});
  t.after(async () => {
    await browser.close();
    await server.close();
  });
  const problems = [];
  const createContext = browser.newContext.bind(browser);
  browser.newContext = async (...arguments_) => {
    const context = await createContext(...arguments_);
    context.on("page", (page) => {
      page.on("console", (message) => { if (message.type() === "error") problems.push(`console.error ${message.text()}`); });
      page.on("pageerror", (error) => problems.push(`pageerror ${error.message}`));
    });
    return context;
  };
  const look = async (fixture) => {
    const opened = await openScene(project, server, browser, scene(fixture));
    t.after(() => opened.context.close());
    const seen = await opened.frame().evaluate(() => ({
      version: window.jQuery?.fn?.jquery,
      htmlSawJquery: window.htmlSawJquery,
      loaded: window.loaded,
      names: Array.from(document.querySelectorAll("#list li"), (item) => item.textContent)
    }));
    await opened.page.clock.runFor(16);
    const readyRan = await opened.frame().evaluate(() => window.readyRan);
    const errors = (await frameEvents(opened.page)).filter(({type}) => type === "frame:error" || type === "frame:unhandled-rejection");
    return {seen, readyRan, errors};
  };

  const recent = await look("recent");
  assert.equal(recent.seen.version, "3.3.1");
  assert.equal(recent.seen.htmlSawJquery, true, "the HTML's inline script saw $");
  assert.equal(recent.readyRan, true, "the $(fn) callback ran once the clock advanced");
  assert.deepEqual(recent.seen.loaded, {isArray: true, count: 3});
  assert.deepEqual(recent.seen.names, ["Ana", "Bo", "Cy"], "recents.sort ran on the fixture's array");
  assert.deepEqual(recent.errors, []);

  const legacy = await look("legacy");
  assert.deepEqual(legacy.seen.loaded, {isArray: true, count: 0}, "the legacy {} arrives as []");
  assert.deepEqual(legacy.seen.names, []);
  assert.deepEqual(legacy.errors, []);
  assert.deepEqual(problems, []);
});
