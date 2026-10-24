import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {readFileSync} from "node:fs";
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import test, {after, before} from "node:test";

import {closeStudioBrowser, createIsolatedContext, detectBrowser, launchStudioBrowser} from "../../dist/capture/browser.js";
import {plan as makePlan} from "../../skills/se-widget-studio/scripts/se-editor-plan.mjs";

// The page scripts that update a sold widget's overlay, run on a hand-written stand-in for the StreamElements overlay
// editor (tests/fixtures/se-editor/editor.html) served at an editor URL, with every other request blocked.
const SCRIPTS = fileURLToPath(new URL("../../skills/se-widget-studio/scripts/", import.meta.url));
const READ = readFileSync(join(SCRIPTS, "se-editor-read.js"), "utf8");
const UPDATE = readFileSync(join(SCRIPTS, "se-editor-update.js"), "utf8");
const FIXTURE = readFileSync(fileURLToPath(new URL("../fixtures/se-editor/editor.html", import.meta.url)), "utf8");
const EDITOR = "https://streamelements.com/overlay/0123456789abcdef01234567/editor";

const OLD = {
  html: "<div id=\"wrap\"></div>\n",
  css: "#wrap { color: red; }\n",
  js: "window.addEventListener('onWidgetLoad', () => {});\n",
  fields: JSON.stringify({speed: {type: "slider", label: "Speed", value: 1}}, null, 2) + "\n"
};
const LONG = "Hide the whole widget this many seconds after each result is shown";
const NEW = {
  html: "<div id=\"wrap\" class=\"stealth\"></div>\n",
  css: "#wrap { color: blue; }\n",
  js: "window.addEventListener('onWidgetLoad', () => { start(); });\n",
  fields: JSON.stringify({
    speed: {type: "slider", label: "Speed", value: 1},
    results: {type: "text", label: "Results command (empty = off)", value: ""},
    hide: {type: "number", label: LONG, value: 0}
  }, null, 2) + "\n"
};
const FILES = {html: "index.html", css: "style.css", js: "script.js", fields: "fields.json"};

let browser;
let root;
let plan;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "sws-se-editor-"));
  const repo = join(root, "widget");
  await mkdir(repo);
  const git = (...args) => execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args]).toString().trim();
  git("init", "-q");
  const commit = async (code) => {
    for (const tab of Object.keys(FILES)) await writeFile(join(repo, FILES[tab]), code[tab]);
    git("add", "-A");
    git("commit", "-q", "-m", "widget");
    return git("rev-parse", "HEAD");
  };
  const from = await commit(OLD);
  await commit(NEW);
  plan = makePlan({repo, from, out: join(root, "upload")});
  const detection = await detectBrowser();
  if (detection.executablePath) ({browser} = await launchStudioBrowser({browserPath: detection.executablePath}));
});

after(async () => {
  if (browser) await closeStudioBrowser(browser);
  if (root) await rm(root, {recursive: true, force: true});
});

const widget = (name, code = OLD, fieldData = {speed: 3}) => ({name, ...code, fieldData});

/** The fixture editor at `url` with these widgets, the page scripts pasted, and every request it made. */
async function editor(t, widgets, {url = EDITOR, update = true} = {}) {
  if (!browser) {
    t.skip("No compatible local Chromium executable is installed; the Studio must not download one implicitly.");
    return undefined;
  }
  const context = await createIsolatedContext({browser, allowedOrigins: [], viewport: {width: 1280, height: 800}});
  t.after(() => context.close());
  const page = await context.newPage();
  const requests = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.route(url, (route) => route.fulfill({status: 200, contentType: "text/html", body: FIXTURE}));
  await page.addInitScript((list) => { window.__FIXTURE_WIDGETS = list; }, widgets);
  await page.goto(url);
  const call = async (expression) => JSON.parse(await page.evaluate(expression));
  const pasted = await call(READ);
  if (pasted.ok && update) {
    assert.equal((await call(`seEditor.use(${JSON.stringify(plan)})`)).ok, true);
    assert.equal((await call(UPDATE)).ok, true);
  }
  return {page, call, pasted, requests, state: () => page.evaluate(() => {
    const {widgets: list, ...counts} = window.__fixture;
    return {...counts, widgets: list.map(({name, html, css, js, fields, fieldData}) => ({name, html, css, js, fields, fieldData}))};
  })};
}

async function upload(session, paths = plan.upload) {
  assert.deepEqual(await session.call("seEditor.attach()"), {ok: true, label: "se-editor-update files", files: Object.values(FILES)});
  await session.page.getByLabel("se-editor-update files").setInputFiles(paths);
  return session.call("seEditor.files()");
}

const codeOf = (state, name) => {
  const {html, css, js, fields} = state.widgets.find((entry) => entry.name === name);
  return {html, css, js, fields: JSON.stringify(JSON.parse(fields))};
};
const normalized = (code) => ({...code, fields: JSON.stringify(JSON.parse(code.fields))});

test("the read-only half refuses any page that is not a StreamElements overlay editor, the Studio's among them", {timeout: 60_000}, async (t) => {
  for (const url of ["http://127.0.0.1:4310/overlay/0123456789abcdef01234567/editor", "https://streamelements.com/dashboard/overlays"]) {
    const session = await editor(t, [widget("minimal")], {url, update: false});
    if (!session) return;
    assert.deepEqual(session.pasted, {ok: false, error: "This page is not a StreamElements overlay editor. Nothing was defined."});
    assert.equal(await session.page.evaluate(() => typeof seEditor), "undefined");
    assert.match((await session.call(UPDATE)).error, /Paste se-editor-read\.js in this tab first/);
  }
});

test("run moves every widget to the new commit, keeps DATA, never saves, and the canvas shows each one", {timeout: 60_000}, async (t) => {
  const session = await editor(t, [widget("minimal"), widget("halloween", OLD, {speed: 9, theme: "dark"})]);
  if (!session) return;
  assert.deepEqual(await session.call("seEditor.layers()"), {ok: true, layers: ["minimal", "halloween"]});
  const before = await session.call("seEditor.canvas()");
  assert.deepEqual({ok: before.ok, js: before.js, css: before.css}, {ok: false, js: {NEW: 0, OLD: 2, OTHER: 0, UNREADABLE: 0}, css: {NEW: 0, OLD: 2, OTHER: 0, UNREADABLE: 0}});
  assert.match((await session.call("seEditor.run(['minimal'])")).error, /Load the new files first/);

  assert.deepEqual(await upload(session), {ok: true, files: {"index.html": "ok", "style.css": "ok", "script.js": "ok", "fields.json": "ok"}});
  assert.equal(await session.page.locator("#se-editor-update-files").count(), 0, "the file input leaves once the files are read");
  const result = await session.call("seEditor.run(['minimal', 'halloween'])");
  const written = {html: "written", css: "written", js: "written", fields: "written"};
  assert.deepEqual(result, {
    ok: true,
    widgets: [{name: "minimal", ok: true, tabs: written}, {name: "halloween", ok: true, tabs: written}],
    canvas: {widgets: 2, js: {NEW: 2, OLD: 0, OTHER: 0, UNREADABLE: 0}, css: {NEW: 2, OLD: 0, OTHER: 0, UNREADABLE: 0}},
    left: 0
  });
  const state = await session.state();
  for (const name of ["minimal", "halloween"]) assert.deepEqual(codeOf(state, name), normalized(NEW), `${name} has the new code`);
  assert.deepEqual(state.widgets.map(({fieldData}) => fieldData), [{speed: 3}, {speed: 9, theme: "dark"}], "DATA is never written");
  assert.deepEqual({saves: state.saves, opens: state.opens, dones: state.dones, writes: state.writes}, {saves: 0, opens: 2, dones: 2, writes: 8});
  assert.equal((await session.call("seEditor.canvas()")).ok, true);

  // The new FIELDS labels, in the panel of the widget Done left selected.
  const labels = await session.call("seEditor.labels()");
  assert.equal(labels.ok, false);
  assert.equal(labels.panel.overflow, false);
  assert.deepEqual(labels.labels.map(({text, status}) => ({text, status})), [
    {text: "Results command (empty = off)", status: "whole"},
    {text: LONG, status: "cut"}
  ]);
  assert.deepEqual(session.requests.filter((url) => !url.startsWith("blob:")), [EDITOR], "nothing but the editor page was requested");
});

test("a widget with code from neither commit stops the run with none of its tabs written", {timeout: 60_000}, async (t) => {
  const edited = {...OLD, js: "window.addEventListener('onWidgetLoad', () => { mine(); });\n"};
  const session = await editor(t, [widget("minimal"), widget("halloween", edited), widget("Paste")]);
  if (!session) return;
  assert.equal((await upload(session)).ok, true);
  const result = await session.call("seEditor.run(['minimal', 'halloween', 'Paste'])");
  assert.equal(result.ok, false);
  assert.deepEqual(result.widgets.map(({name, ok}) => ({name, ok})), [{name: "minimal", ok: true}, {name: "halloween", ok: false}]);
  assert.equal(result.left, 2, "halloween's CSS and all of Paste are still the old commit's");
  const stopped = result.widgets[1];
  assert.match(stopped.error, /^Unexpected code in js: nothing was written\. The code editor is still open\.$/);
  assert.deepEqual(Object.fromEntries(Object.entries(stopped.tabs).map(([tab, value]) => [tab, value.split(" ")[0]])), {html: "OLD", css: "OLD", js: "OTHER", fields: "OLD"});
  const state = await session.state();
  assert.equal(state.writes, 4, "only the first widget's four tabs were written");
  assert.deepEqual(codeOf(state, "halloween"), normalized(edited));
  assert.deepEqual(codeOf(state, "Paste"), normalized(OLD), "the run stops at the first widget it cannot write");
  assert.equal(await session.page.locator("md-dialog.code-editor-dialog").count(), 1, "the editor stays open to look at");
  assert.match((await session.call("seEditor.open('Paste')")).error, /A code editor is already open/);
});

test("a widget already on the new commit, or half way there, gets only its old tabs", {timeout: 60_000}, async (t) => {
  const half = {...OLD, html: NEW.html, fields: NEW.fields};
  const session = await editor(t, [widget("minimal", NEW), widget("halloween", half)]);
  if (!session) return;
  assert.equal((await upload(session)).ok, true);
  const result = await session.call("seEditor.run(['minimal', 'halloween'])");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.left, 0);
  assert.deepEqual(result.widgets.map(({tabs}) => tabs), [
    {html: "already new", css: "already new", js: "already new", fields: "already new"},
    {html: "already new", css: "written", js: "written", fields: "already new"}
  ]);
  const state = await session.state();
  assert.equal(state.writes, 2);
  for (const name of ["minimal", "halloween"]) assert.deepEqual(codeOf(state, name), normalized(NEW));
});

test("files that are not the plan's new commit are refused, and nothing runs without them", {timeout: 60_000}, async (t) => {
  const session = await editor(t, [widget("minimal")]);
  if (!session) return;
  const wrong = join(root, "wrong");
  await mkdir(wrong, {recursive: true});
  const paths = plan.upload.slice(0, 3);
  await writeFile(join(wrong, "script.js"), OLD.js);
  paths[2] = join(wrong, "script.js");
  const checked = await upload(session, paths);
  assert.equal(checked.ok, false);
  assert.match(checked.files["script.js"], /^MISMATCH [0-9a-f]{12}$/);
  assert.equal(checked.files["fields.json"], "missing");
  assert.match((await session.call("seEditor.run(['minimal'])")).error, /Load the new files first/);
  assert.equal((await session.state()).opens, 0);
});

test("a tab the editor changes as it is written puts every written tab back", {timeout: 60_000}, async (t) => {
  const session = await editor(t, [widget("minimal")]);
  if (!session) return;
  assert.equal((await upload(session)).ok, true);
  await session.page.evaluate(() => { window.__fixture.mangle = "js"; });
  const result = await session.call("seEditor.run(['minimal'])");
  assert.equal(result.ok, false);
  assert.match(result.widgets[0].error, /^The editor changed the js code as it was written \([0-9a-f]{12}\): the tabs written were put back\. The code editor is still open\.$/);
  assert.deepEqual(result.widgets[0].restored, {js: "restored", css: "restored", html: "restored"});
  const models = await session.page.evaluate(() => Object.fromEntries(monaco.editor.getModels().map((model) => [model.tab, model.getValue()])));
  assert.deepEqual({html: models.html, css: models.css, js: models.js}, {html: OLD.html, css: OLD.css, js: OLD.js});
  assert.equal((await session.state()).dones, 0);
});

test("a widget whose canvas never shows the new code after Done stops the run", {timeout: 60_000}, async (t) => {
  const session = await editor(t, [widget("minimal"), widget("halloween")]);
  if (!session) return;
  assert.equal((await upload(session)).ok, true);
  await session.page.evaluate(() => { window.__fixture.frozen = true; });
  const result = await session.call("seEditor.run(['minimal', 'halloween'])");
  assert.equal(result.ok, false);
  assert.deepEqual(result.widgets.map(({name, ok}) => ({name, ok})), [{name: "minimal", ok: false}]);
  assert.equal(result.widgets[0].error, "No more widgets in the canvas show the new js and css after Done: the code may not have reached the widget.");
  assert.equal(result.left, 2);
});

test("nothing runs while the editor tab is in the background", {timeout: 60_000}, async (t) => {
  const session = await editor(t, [widget("minimal")]);
  if (!session) return;
  assert.equal((await upload(session)).ok, true);
  await session.page.evaluate(() => Object.defineProperty(document, "visibilityState", {get: () => "hidden"}));
  for (const call of ["seEditor.run(['minimal'])", "seEditor.open('minimal')", "seEditor.apply()"]) {
    assert.match((await session.call(call)).error, /in the background/);
  }
  assert.deepEqual(await session.state().then(({selections, opens}) => ({selections, opens})), {selections: 0, opens: 0});
});
