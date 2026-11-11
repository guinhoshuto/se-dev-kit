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
const LOAD = readFileSync(join(SCRIPTS, "se-editor-load.js"), "utf8");
const READ_FILE = join(SCRIPTS, "se-editor-read.js");
const UPDATE_FILE = join(SCRIPTS, "se-editor-update.js");
const READ = readFileSync(READ_FILE, "utf8");
const UPDATE = readFileSync(UPDATE_FILE, "utf8");
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
// {{field}} placeholders in the CSS at both commits, and {{field}} and a FIELDS key's {field} in the JS at the new one,
// which the canvas shows filled.
const STYLE = {color: {type: "colorpicker", label: "Color", value: "red"}, size: {type: "number", label: "Size", value: 24}};
const OLD_FILLED = {
  ...OLD,
  css: "#wrap { color: {{color}}; }\n#wrap .name { font-weight: 700; letter-spacing: 1px; font-size: {{size}}px; }\n",
  fields: JSON.stringify({...JSON.parse(OLD.fields), ...STYLE}, null, 2) + "\n"
};
const NEW_FILLED = {
  ...NEW,
  css: "#wrap { border: 2px solid {{ color }}; color: {{color}}; }\n#wrap .name { font-weight: 700; letter-spacing: 1px; font-size: {{size}}px; }\n",
  js: "window.addEventListener('onWidgetLoad', () => { start({{speed}}, `${color}`); });\n",
  fields: JSON.stringify({...JSON.parse(NEW.fields), ...STYLE}, null, 2) + "\n"
};
// A change next to a placeholder only: once filled, the new CSS fits both commits.
const OLD_UNIT = {...OLD, css: "#wrap { font-size: {{size}}; }\n"};
const NEW_UNIT = {...OLD, css: "#wrap { font-size: {{size}}px; }\n"};

let browser;
let root;
let plan;
let filled;
let unit;

/** The plan from `first` to `second`, committed in a new widget repository named `name`. */
async function planOf(name, first, second) {
  const repo = join(root, name);
  await mkdir(repo);
  const git = (...args) => execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args]).toString().trim();
  git("init", "-q");
  const commit = async (code) => {
    for (const tab of Object.keys(FILES)) await writeFile(join(repo, FILES[tab]), code[tab]);
    git("add", "-A");
    git("commit", "-q", "-m", "widget");
    return git("rev-parse", "HEAD");
  };
  const from = await commit(first);
  await commit(second);
  return makePlan({repo, from, out: join(root, `${name}-upload`)});
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "sws-se-editor-"));
  plan = await planOf("widget", OLD, NEW);
  filled = await planOf("filled", OLD_FILLED, NEW_FILLED);
  unit = await planOf("unit", OLD_UNIT, NEW_UNIT);
  const detection = await detectBrowser();
  if (detection.executablePath) ({browser} = await launchStudioBrowser({browserPath: detection.executablePath}));
});

after(async () => {
  if (browser) await closeStudioBrowser(browser);
  if (root) await rm(root, {recursive: true, force: true});
});

const widget = (name, code = OLD, fieldData = {speed: 3}) => ({name, ...code, fieldData});

/** The fixture editor at `url` with these widgets, the page scripts pasted, and every request it made. */
async function editor(t, widgets, {url = EDITOR, update = true, using = plan, ui} = {}) {
  const session = await fixture(t, widgets, {url, ui});
  if (!session) return undefined;
  const pasted = await session.call(READ);
  if (pasted.ok && update) {
    if (using) assert.equal((await session.call(`seEditor.use(${JSON.stringify(using)})`)).ok, true);
    assert.equal((await session.call(UPDATE)).ok, true);
  }
  return {...session, pasted};
}

/**
 * The fixture editor at `url` with these widgets, nothing pasted yet, served with these response headers. `ui` is the
 * fixture's code editor markup: "react" loads the page at `?ui=react`, the React dialog of StreamElements' 2026-11-11
 * redesign; without it the page is the AngularJS Material editor.
 */
async function fixture(t, widgets, {url = EDITOR, headers = {}, ui} = {}) {
  if (!browser) {
    t.skip("No compatible local Chromium executable is installed; the Studio must not download one implicitly.");
    return undefined;
  }
  const context = await createIsolatedContext({browser, allowedOrigins: [], viewport: {width: 1280, height: 800}});
  t.after(() => context.close());
  const page = await context.newPage();
  const requests = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.route((target) => `${target.origin}${target.pathname}` === url, (route) => route.fulfill({status: 200, contentType: "text/html", headers, body: FIXTURE}));
  await page.addInitScript((list) => { window.__FIXTURE_WIDGETS = list; }, widgets);
  await page.goto(ui ? `${url}?ui=${ui}` : url);
  const call = async (expression) => JSON.parse(await page.evaluate(expression));
  return {page, call, requests, state: () => page.evaluate(() => {
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
const count = (counts) => ({NEW: 0, OLD: 0, UNVERIFIABLE: 0, OTHER: 0, UNREADABLE: 0, ...counts});

test("the read-only half refuses any page that is not a StreamElements overlay editor, the Studio's among them", {timeout: 60_000}, async (t) => {
  for (const url of ["http://127.0.0.1:4310/overlay/0123456789abcdef01234567/editor", "https://streamelements.com/dashboard/overlays"]) {
    const session = await editor(t, [widget("minimal")], {url, update: false});
    if (!session) return;
    assert.deepEqual(session.pasted, {ok: false, error: "This page is not a StreamElements overlay editor. Nothing was defined."});
    assert.equal(await session.page.evaluate(() => typeof seEditor), "undefined");
    assert.match((await session.call(UPDATE)).error, /Load se-editor-read\.js in this tab first/);
  }
});

test("run moves every widget to the new commit, keeps DATA, never saves, and the canvas shows each one", {timeout: 60_000}, async (t) => {
  const session = await editor(t, [widget("minimal"), widget("halloween", OLD, {speed: 9, theme: "dark"})]);
  if (!session) return;
  assert.deepEqual(await session.call("seEditor.layers()"), {ok: true, layers: ["minimal", "halloween"]});
  const before = await session.call("seEditor.canvas()");
  assert.deepEqual({ok: before.ok, js: before.js, css: before.css}, {ok: false, js: count({OLD: 2}), css: count({OLD: 2})});
  assert.match((await session.call("seEditor.run(['minimal'])")).error, /Load the new files first/);

  assert.deepEqual(await upload(session), {ok: true, files: {"index.html": "ok", "style.css": "ok", "script.js": "ok", "fields.json": "ok"}});
  assert.equal(await session.page.locator("#se-editor-update-files").count(), 0, "the file input leaves once the files are read");
  const result = await session.call("seEditor.run(['minimal', 'halloween'])");
  const written = {html: "written", css: "written", js: "written", fields: "written"};
  assert.deepEqual(result, {
    ok: true,
    widgets: [{name: "minimal", ok: true, tabs: written}, {name: "halloween", ok: true, tabs: written}],
    canvas: {widgets: 2, js: count({NEW: 2}), css: count({NEW: 2})},
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

test("the canvas tells the commits apart by the code around the {{field}} placeholders it shows filled", {timeout: 60_000}, async (t) => {
  // A field value that repeats the start of the code after its placeholder, then differs.
  const injected = "blue; }\n#wrap .name { font-weight: 777";
  const edited = {...OLD_FILLED, css: `${OLD_FILLED.css}.mine { margin: 0; }\n`};
  const session = await editor(t, [
    widget("old", OLD_FILLED, {color: "red", size: 24}),
    widget("new", NEW_FILLED, {color: "#ff7518", size: 30, speed: 9}),
    widget("injected", OLD_FILLED, {color: injected, size: 18}),
    widget("edited", edited, {color: "red", size: 24})
  ], {update: false});
  if (!session) return;
  const broken = {...filled, tabs: {...filled.tabs, css: {...filled.tabs.css, templates: {old: [{head: "#", length: -1, sha256: filled.tabs.css.old}, filled.tabs.css.templates.old[1]]}}}};
  assert.match((await session.call(`seEditor.use(${JSON.stringify(broken)})`)).error, /The plan's css templates need two or more pieces/);
  assert.deepEqual((await session.call(`seEditor.use(${JSON.stringify(filled)})`)).placeholders, ["js", "css"]);
  const frames = await session.page.evaluate(async () => Promise.all([...document.querySelectorAll("iframe")].map(async (frame) => (await fetch(frame.src)).text())));
  assert.ok(frames.every((text) => !text.includes("{{")), "the canvas shows every placeholder filled");
  const canvas = await session.call("seEditor.canvas()");
  assert.deepEqual(canvas.each, [{js: "OLD", css: "OLD"}, {js: "NEW", css: "NEW"}, {js: "OLD", css: "OLD"}, {js: "OLD", css: "OTHER"}]);
  assert.deepEqual(session.requests.filter((url) => !url.startsWith("blob:")), [EDITOR]);
});

test("an overlay whose CSS has {{field}} placeholders moves in one run, one Save, and a reload the canvas confirms", {timeout: 60_000}, async (t) => {
  const data = [{color: "red", size: 24, speed: 3}, {color: "#ff7518", size: 30, speed: 9, theme: "dark"}];
  const session = await editor(t, [widget("minimal", OLD_FILLED, data[0]), widget("halloween", OLD_FILLED, data[1])], {using: filled});
  if (!session) return;
  const before = await session.call("seEditor.canvas()");
  assert.deepEqual({js: before.js, css: before.css}, {js: count({OLD: 2}), css: count({OLD: 2})});
  assert.equal((await upload(session, filled.upload)).ok, true);
  const result = await session.call("seEditor.run(['minimal', 'halloween'])");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual({canvas: result.canvas, left: result.left}, {canvas: {widgets: 2, js: count({NEW: 2}), css: count({NEW: 2})}, left: 0});
  assert.equal((await session.state()).saves, 0, "the page scripts never save");

  await session.page.click("#save");
  assert.equal((await session.state()).saves, 1);
  await session.page.reload();
  assert.equal((await session.call(READ)).ok, true);
  assert.equal((await session.call(`seEditor.use(${JSON.stringify(filled)})`)).ok, true);
  const after = await session.call("seEditor.canvas()");
  assert.deepEqual({ok: after.ok, js: after.js, css: after.css}, {ok: true, js: count({NEW: 2}), css: count({NEW: 2})});
  const state = await session.state();
  for (const name of ["minimal", "halloween"]) assert.deepEqual(codeOf(state, name), normalized(NEW_FILLED), `${name} saved the new code`);
  assert.deepEqual(state.widgets.map(({fieldData}) => fieldData), data, "DATA is never written");
  assert.ok(session.requests.every((url) => url.startsWith("blob:") || url === EDITOR), "nothing but the editor page was requested");
});

test("code that fits both commits once its placeholders are filled reads UNVERIFIABLE, and run takes it as shown", {timeout: 60_000}, async (t) => {
  const session = await editor(t, [widget("minimal", OLD_UNIT, {size: 24})], {using: unit});
  if (!session) return;
  assert.deepEqual((await session.call("seEditor.canvas()")).css, count({OLD: 1}));
  assert.equal((await upload(session, unit.upload)).ok, true);
  const result = await session.call("seEditor.run(['minimal'])");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.widgets[0].tabs, {html: "already new", css: "written", js: "already new", fields: "already new"});
  assert.deepEqual({css: result.canvas.css, left: result.left}, {css: count({UNVERIFIABLE: 1}), left: 0});
  assert.equal((await session.call("seEditor.canvas()")).ok, false, "the canvas cannot confirm it");
});

// The flows that reach the code editor, once on each markup of it: the AngularJS Material dialog and the React dialog
// StreamElements switched to (seen 2026-11-11). The fixture's React dialog stays in the page, hidden, after Done (the
// real one left the page), so that the visibility guard of dialog() has something to refuse.
const SHOWN = {angular: "md-dialog.code-editor-dialog", react: "[role=\"dialog\"].bg-popover:visible"};
const IN_PAGE = {angular: "md-dialog.code-editor-dialog", react: "[role=\"dialog\"].bg-popover"};
const UIS = {angular: undefined, react: "react"};
const NO_EDITOR = {ok: false, error: "No code editor is open."};

for (const [ui, markup] of Object.entries(UIS)) {
  test(`${ui} editor: open, scan, apply, and done move one widget, and the closed dialog is not an open editor`, {timeout: 60_000}, async (t) => {
    const session = await editor(t, [widget("minimal"), widget("halloween")], {ui: markup});
    if (!session) return;
    assert.equal((await upload(session)).ok, true);
    assert.deepEqual(await session.call("seEditor.scan()"), NO_EDITOR);
    assert.deepEqual(await session.call("seEditor.done()"), NO_EDITOR);

    assert.deepEqual(await session.call("seEditor.open('minimal')"), {ok: true});
    assert.equal(await session.page.locator(SHOWN[ui]).count(), 1);
    const scanned = await session.call("seEditor.scan()");
    assert.equal(scanned.ok, true, "every tab holds one of the two commits' code");
    assert.deepEqual(Object.values(scanned.tabs).map((value) => value.split(" ")[0]), ["OLD", "OLD", "OLD", "OLD"]);
    const applied = await session.call("seEditor.apply()");
    assert.deepEqual(applied, {ok: true, tabs: {html: "written", css: "written", js: "written", fields: "written"}});
    assert.deepEqual(await session.call("seEditor.done()"), {ok: true});
    assert.equal(await session.page.locator(SHOWN[ui]).count(), 0, "no code editor is on the screen after Done");
    assert.deepEqual(await session.call("seEditor.scan()"), NO_EDITOR, "a closed dialog is no open editor");
    assert.deepEqual(await session.call("seEditor.done()"), NO_EDITOR);

    // The next editor opens at once, and what it shows is what Done kept.
    assert.deepEqual(await session.call("seEditor.open('minimal')"), {ok: true});
    assert.equal(await session.page.locator(SHOWN[ui]).count(), 1, "one code editor is on the screen again");
    const again = await session.call("seEditor.scan()");
    assert.equal(again.ok, true, JSON.stringify(again));
    assert.deepEqual(Object.values(again.tabs).map((value) => value.split(" ")[0]), ["NEW", "NEW", "NEW", "NEW"]);
    assert.deepEqual(await session.call("seEditor.done()"), {ok: true});

    const state = await session.state();
    assert.deepEqual(codeOf(state, "minimal"), normalized(NEW));
    assert.deepEqual(codeOf(state, "halloween"), normalized(OLD), "the other widget is untouched");
    assert.deepEqual({saves: state.saves, opens: state.opens, dones: state.dones, writes: state.writes}, {saves: 0, opens: 2, dones: 2, writes: 4});
    assert.equal(await session.page.locator(IN_PAGE[ui]).count(), ui === "react" ? 2 : 0, "the fixture's React dialog stays in the page, hidden; the AngularJS one leaves");
  });

  test(`${ui} editor: run moves every widget, never saves, and the canvas shows each one`, {timeout: 60_000}, async (t) => {
    const session = await editor(t, [widget("minimal"), widget("halloween", OLD, {speed: 9, theme: "dark"})], {ui: markup});
    if (!session) return;
    assert.equal((await upload(session)).ok, true);
    const result = await session.call("seEditor.run(['minimal', 'halloween'])");
    const written = {html: "written", css: "written", js: "written", fields: "written"};
    assert.deepEqual(result, {
      ok: true,
      widgets: [{name: "minimal", ok: true, tabs: written}, {name: "halloween", ok: true, tabs: written}],
      canvas: {widgets: 2, js: count({NEW: 2}), css: count({NEW: 2})},
      left: 0
    });
    const state = await session.state();
    for (const name of ["minimal", "halloween"]) assert.deepEqual(codeOf(state, name), normalized(NEW), `${name} has the new code`);
    assert.deepEqual(state.widgets.map(({fieldData}) => fieldData), [{speed: 3}, {speed: 9, theme: "dark"}], "DATA is never written");
    assert.deepEqual({saves: state.saves, opens: state.opens, dones: state.dones, writes: state.writes}, {saves: 0, opens: 2, dones: 2, writes: 8});
    assert.equal(await session.page.locator(SHOWN[ui]).count(), 0);
    assert.equal((await session.call("seEditor.canvas()")).ok, true);
    assert.deepEqual(session.requests.filter((url) => !url.startsWith("blob:")), [markup ? `${EDITOR}?ui=${markup}` : EDITOR]);
  });

  test(`${ui} editor: a widget with code from neither commit writes nothing and leaves the editor open`, {timeout: 60_000}, async (t) => {
    const edited = {...OLD, js: "window.addEventListener('onWidgetLoad', () => { mine(); });\n"};
    const session = await editor(t, [widget("halloween", edited), widget("Paste")], {ui: markup});
    if (!session) return;
    assert.equal((await upload(session)).ok, true);
    assert.deepEqual(await session.call("seEditor.open('halloween')"), {ok: true});
    const scanned = await session.call("seEditor.scan()");
    assert.equal(scanned.ok, false);
    assert.deepEqual(Object.fromEntries(Object.entries(scanned.tabs).map(([tab, value]) => [tab, value.split(" ")[0]])), {html: "OLD", css: "OLD", js: "OTHER", fields: "OLD"});
    const applied = await session.call("seEditor.apply()");
    assert.equal(applied.ok, false);
    assert.match(applied.error, /^Unexpected code in js: nothing was written\.$/);
    assert.equal((await session.state()).writes, 0);
    assert.equal(await session.page.locator(SHOWN[ui]).count(), 1, "the editor stays open to look at");
    assert.match((await session.call("seEditor.open('Paste')")).error, /A code editor is already open/);
    assert.deepEqual(await session.call("seEditor.done()"), {ok: true});
    assert.equal(await session.page.locator(SHOWN[ui]).count(), 0);
    assert.deepEqual(codeOf(await session.state(), "halloween"), normalized(edited), "Done kept the code as it was");
  });
}

// A widget's field panel, with each kind of field, for setField and readField. They need no plan.
const ITEMS = "Items (comma-separated)";
const FORM = {
  ...OLD,
  fields: JSON.stringify({
    items: {type: "text", label: ITEMS, value: ""},
    notes: {type: "text", mode: "textarea", label: "Notes", value: "first"},
    delay: {type: "number", label: "Delay", value: 5, max: 10},
    bits: {type: "number", label: "Bits", value: 100},
    speed: {type: "slider", label: "Speed", value: 1},
    link: {type: "url", label: "Link", value: "https://example.com/"},
    fixed: {type: "search", label: "Fixed", value: "kept", readonly: true},
    tint: {type: "colorpicker", label: "Tint", value: "#ff0000"},
    theme: {type: "dropdown", label: "Theme", value: "dark"},
    loop: {type: "checkbox", label: "Loop", value: true},
    secret: {type: "password", label: "Secret", value: "hunter2"},
    mystery: {type: "text", label: "Mystery items", value: "$10, $20", group: "Mystery slices"},
    twinA: {type: "text", label: "Twin", value: "a", group: "One"},
    twinB: {type: "text", label: "Twin", value: "b", group: "Two"}
  }, null, 2) + "\n"
};
const formEditor = (t, widgets) => editor(t, widgets, {using: null});
const fieldDataOf = async (session) => (await session.state()).widgets.map(({fieldData}) => fieldData);

test("setField writes a field by its label and returns the old value, without Save or opening a group", {timeout: 60_000}, async (t) => {
  const session = await formEditor(t, [widget("minimal", FORM, {items: "a, b", speed: 3})]);
  if (!session) return;
  assert.deepEqual(await session.call(`seEditor.readField(${JSON.stringify(ITEMS)})`), {ok: true, layer: "minimal", label: ITEMS, value: "a, b"});
  assert.deepEqual(await fieldDataOf(session), [{items: "a, b", speed: 3}], "reading changes nothing");

  assert.deepEqual(await session.call(`seEditor.setField(${JSON.stringify(ITEMS)}, "x, y", "minimal")`), {ok: true, layer: "minimal", label: ITEMS, old: "a, b", value: "x, y"});
  assert.deepEqual(await session.call("seEditor.setField('Notes', 'second')"), {ok: true, layer: "minimal", label: "Notes", old: "first", value: "second"});
  assert.deepEqual(await session.call("seEditor.setField('Delay', 7)"), {ok: true, layer: "minimal", label: "Delay", old: "5", value: "7"});
  // A number field shows its value grouped.
  assert.deepEqual(await session.call("seEditor.setField('Bits', 1500)"), {ok: true, layer: "minimal", label: "Bits", old: "100", value: "1,500"});
  assert.deepEqual(await session.call("seEditor.setField('Speed', 9)"), {ok: true, layer: "minimal", label: "Speed", old: "3", value: "9"});
  assert.deepEqual(await session.call("seEditor.setField('Link', 'https://example.com/new')"), {ok: true, layer: "minimal", label: "Link", old: "https://example.com/", value: "https://example.com/new"});
  // A closed group keeps its input in the page, and stays closed: a group left open is saved with the overlay.
  assert.deepEqual(await session.call("seEditor.setField('Mystery items', '$10[$5 FEE], $20')"), {ok: true, layer: "minimal", label: "Mystery items", old: "$10, $20", value: "$10[$5 FEE], $20"});
  assert.equal(await session.page.locator(".custom-fields__toggle", {hasText: "Mystery slices"}).getAttribute("aria-expanded"), "false");

  const written = {items: "x, y", speed: 9, notes: "second", delay: 7, bits: 1500, link: "https://example.com/new", mystery: "$10[$5 FEE], $20"};
  assert.deepEqual(await fieldDataOf(session), [written], "each value reached the widget's data");
  const state = await session.state();
  assert.deepEqual({saves: state.saves, toggles: state.toggles, selections: state.selections, renames: state.renames, decoyReads: state.decoyReads}, {saves: 0, toggles: 0, selections: 1, renames: 0, decoyReads: 0});

  await session.page.click("#save");
  await session.page.reload();
  assert.equal((await session.call(READ)).ok, true);
  assert.equal((await session.call(UPDATE)).ok, true);
  assert.equal(JSON.parse(await session.page.evaluate(`seEditor.readField('Mystery items')`)).value, "$10[$5 FEE], $20", "what was saved reads back after the reload");
});

test("an unknown label changes nothing and says so", {timeout: 60_000}, async (t) => {
  const session = await formEditor(t, [widget("minimal", FORM, {items: "a, b"})]);
  if (!session) return;
  for (const label of ["Nope", "Items", ITEMS.slice(1)]) {
    for (const call of [`seEditor.readField(${JSON.stringify(label)})`, `seEditor.setField(${JSON.stringify(label)}, 'x')`]) {
      const result = await session.call(call);
      assert.equal(result.ok, false);
      assert.match(result.error, new RegExp(`^No field of "minimal" is labelled "${label.replace(/[()]/g, "\\$&")}": nothing was read or written`));
    }
  }
  assert.deepEqual(await fieldDataOf(session), [{items: "a, b"}]);
  assert.match((await session.call("seEditor.readField('')")).error, /Pass the field's label/);
});

test("neither call reads or writes an input outside the widget's fields, the overlay's link above all", {timeout: 60_000}, async (t) => {
  const session = await formEditor(t, [widget("minimal", FORM, {items: "a, b"})]);
  if (!session) return;
  for (const label of ["Overlay url", "Custom widget name", "Outside the form"]) {
    for (const call of [`seEditor.readField(${JSON.stringify(label)})`, `seEditor.setField(${JSON.stringify(label)}, 'x')`]) {
      const text = await session.page.evaluate(call);
      assert.doesNotMatch(text, /FIXTUREKEY|FIXTUREOUTSIDE/);
      assert.match(JSON.parse(text).error, new RegExp(`^No field of "minimal" is labelled "${label}"`));
    }
  }
  assert.equal((await session.state()).decoyReads, 0, "no decoy's value was read, even to be dropped");
  assert.equal(await session.page.evaluate(() => document.getElementById("overlay-url").value.endsWith("FIXTUREKEY")), true, "and the link is as it was");
});

test("a value holding an overlay's link answers with its key hidden, and stays as it is in the field", {timeout: 60_000}, async (t) => {
  const link = "https://streamelements.com/overlay/0123456789abcdef01234567/FIXTUREKEY2";
  const masked = "https://streamelements.com/overlay/<id>/<key>";
  const session = await formEditor(t, [widget("minimal", FORM, {notes: link})]);
  if (!session) return;
  const read = await session.page.evaluate("seEditor.readField('Notes')");
  assert.doesNotMatch(read, /FIXTUREKEY2/);
  assert.equal(JSON.parse(read).value, masked);
  assert.equal(await session.page.evaluate(() => document.querySelector("textarea").value), link, "reading leaves it alone");
  const written = await session.page.evaluate(`seEditor.setField('Notes', ${JSON.stringify(`${link}/more`)})`);
  assert.doesNotMatch(written, /FIXTUREKEY2/);
  assert.deepEqual(JSON.parse(written), {ok: true, layer: "minimal", label: "Notes", old: masked, value: masked});
  assert.deepEqual(await fieldDataOf(session), [{notes: `${link}/more`}], "the field keeps the value it was given");
});

test("a field that is not one text or number input, or two fields with one label, are refused", {timeout: 60_000}, async (t) => {
  const session = await formEditor(t, [widget("minimal", FORM, {theme: "dark"})]);
  if (!session) return;
  for (const label of ["Tint", "Theme", "Loop", "Secret", "Fixed"]) {
    for (const call of [`seEditor.readField('${label}')`, `seEditor.setField('${label}', 'x')`]) {
      const text = await session.page.evaluate(call);
      assert.doesNotMatch(text, /hunter2|"kept"|"dark"/);
      assert.match(JSON.parse(text).error, new RegExp(`^The field "${label}" of "minimal" is not one text or number input`));
    }
  }
  assert.match((await session.call("seEditor.setField('Twin', 'x')")).error, /^2 fields of "minimal" are labelled "Twin": nothing was read or written\.$/);
  assert.match((await session.call("seEditor.readField('Twin')")).error, /^2 fields of "minimal" are labelled "Twin"/);
  assert.deepEqual(await fieldDataOf(session), [{theme: "dark"}]);
});

test("a call names its layer, and writes that layer's field, never the one still on the page", {timeout: 60_000}, async (t) => {
  const session = await formEditor(t, [
    widget("minimal", FORM, {items: "one"}),
    widget("halloween", FORM, {items: "two"}),
    widget("twin", FORM, {}),
    widget("twin", FORM, {}),
    {name: "image", plain: true, ...OLD, fieldData: {}}
  ]);
  if (!session) return;
  assert.match((await session.call(`seEditor.setField(${JSON.stringify(ITEMS)}, 'x')`)).error, /^Name the layer, one of: minimal, halloween, twin, twin, image\.$/);
  assert.match((await session.call("seEditor.readField('Notes', 'nobody')")).error, /^No layer is named "nobody"\.$/);
  assert.match((await session.call("seEditor.readField('Notes', 'twin')")).error, /^2 layers are named "twin"/);
  assert.equal((await session.state()).selections, 0, "no layer was clicked yet");

  assert.equal((await session.call(`seEditor.setField(${JSON.stringify(ITEMS)}, 'A', 'minimal')`)).old, "one");
  // The panel on the page is still minimal's for a moment after halloween is selected.
  assert.deepEqual(await session.call(`seEditor.setField(${JSON.stringify(ITEMS)}, 'B', 'halloween')`), {ok: true, layer: "halloween", label: ITEMS, old: "two", value: "B"});
  assert.deepEqual((await fieldDataOf(session)).slice(0, 2), [{items: "A"}, {items: "B"}]);
  // The list marks a layer only after its fields show: right after a switch, two calls on the layer it still names.
  for (const call of [1, 2]) {
    assert.deepEqual(await session.call(`seEditor.readField(${JSON.stringify(ITEMS)}, 'minimal')`), {ok: true, layer: "minimal", label: ITEMS, value: "A"}, `call ${call}`);
  }
  assert.deepEqual(await session.call(`seEditor.readField(${JSON.stringify(ITEMS)}, 'halloween')`), {ok: true, layer: "halloween", label: ITEMS, value: "B"});
  // Two layers marked (a group's selection) are not this layer's panel.
  await session.page.evaluate(() => document.querySelectorAll(".widget-layers-list-item").forEach((row) => row.classList.add("selected")));
  assert.equal((await session.call(`seEditor.readField(${JSON.stringify(ITEMS)}, 'minimal')`)).value, "A");

  assert.match((await session.call("seEditor.readField('Notes', 'image')")).error, /^"image" shows no field panel/);
  assert.match((await session.call("seEditor.readField('Notes', 'image')")).error, /^"image" shows no field panel/, "selected already, it says the same");
  const state = await session.state();
  assert.deepEqual({selections: state.selections, renames: state.renames}, {selections: 6, renames: 0});
});

test("a click the layer list never marks stops the call, with nothing written to the layer on the page", {timeout: 60_000}, async (t) => {
  const session = await formEditor(t, [widget("minimal", FORM, {items: "one"}), widget("halloween", FORM, {items: "two"})]);
  if (!session) return;
  assert.equal((await session.call(`seEditor.readField(${JSON.stringify(ITEMS)}, 'minimal')`)).value, "one");
  await session.page.evaluate(() => { window.__fixture.unmarked = true; });
  assert.match((await session.call(`seEditor.setField(${JSON.stringify(ITEMS)}, 'x', 'halloween')`)).error, /^"halloween" shows no field panel/);
  assert.deepEqual(await fieldDataOf(session), [{items: "one"}, {items: "two"}]);
});

test("a value the editor does not keep is put back, and says so when it cannot be", {timeout: 60_000}, async (t) => {
  const session = await formEditor(t, [widget("minimal", FORM, {delay: 5}), widget("over", FORM, {delay: 50})]);
  if (!session) return;
  assert.deepEqual(await session.call("seEditor.setField('Delay', 99, 'minimal')"), {
    ok: false, layer: "minimal", label: "Delay", old: "5", shown: "10", restored: true,
    error: 'The editor showed "10" for "99": the old value was put back.'
  });
  // Already above its max: putting it back clamps it again.
  const over = await session.call("seEditor.setField('Delay', 99, 'over')");
  assert.deepEqual({old: over.old, shown: over.shown, restored: over.restored}, {old: "50", shown: "10", restored: false});
  assert.equal(over.error, 'The editor showed "10" for "99": the old value did not come back: do not Save.');
  assert.deepEqual((await fieldDataOf(session)).map(({delay}) => delay), [5, 10]);
  // Only a number field's grouping is forgiven: this one lost the spaces the browser strips from a URL.
  const url = await session.call("seEditor.setField('Link', ' https://example.com/new ', 'minimal')");
  assert.deepEqual({ok: url.ok, old: url.old, shown: url.shown, restored: url.restored}, {ok: false, old: "https://example.com/", shown: "https://example.com/new", restored: true});
  assert.equal((await fieldDataOf(session))[0].link, "https://example.com/");
  assert.equal((await session.state()).saves, 0);
});

test("setField refuses a value that is not a string or a number, and neither runs in the background", {timeout: 60_000}, async (t) => {
  const session = await formEditor(t, [widget("minimal", FORM, {items: "a"})]);
  if (!session) return;
  for (const value of ["undefined", "{a: 1}", "NaN", "null"]) {
    assert.match((await session.call(`seEditor.setField(${JSON.stringify(ITEMS)}, ${value})`)).error, /^Pass the value as a string or a number\.$/);
  }
  assert.equal((await session.state()).selections, 0);
  await session.page.evaluate(() => Object.defineProperty(document, "visibilityState", {get: () => "hidden"}));
  for (const call of [`seEditor.readField(${JSON.stringify(ITEMS)})`, `seEditor.setField(${JSON.stringify(ITEMS)}, 'x')`]) {
    assert.match((await session.call(call)).error, /in the background/);
  }
  assert.equal((await session.state()).selections, 0);
  assert.deepEqual(await fieldDataOf(session), [{items: "a"}]);
});

const READ_CALLS = ["use(plan)", "layers()", "await canvas()", "labels([texts])"];
const LOADER_LABEL = "se-editor-load files";
const NO_SCRIPT = {ok: false, error: "Upload se-editor-read.js or se-editor-update.js."};

/** The fixture editor with the loader pasted, and a function that uploads to its input and answers its load. */
async function loader(t, widgets, options) {
  const session = await fixture(t, widgets, options);
  if (!session) return undefined;
  assert.ok(LOAD.length < 1000, `the text pasted is ${LOAD.length} characters`);
  assert.deepEqual(await session.call(LOAD), {ok: true, label: LOADER_LABEL});
  const load = async (paths) => {
    await session.page.getByLabel(LOADER_LABEL).setInputFiles(paths);
    return session.call("seEditorLoad()");
  };
  return {...session, load, inputs: () => session.page.getByLabel(LOADER_LABEL).count()};
}

test("the loader defines seEditor from an uploaded file, with no page script's text in a call, and the update runs on what it loaded", {timeout: 60_000}, async (t) => {
  const session = await loader(t, [widget("minimal")]);
  if (!session) return;
  assert.equal(await session.page.evaluate(() => typeof seEditor), "undefined", "the loader alone defines no page script");
  assert.equal(await session.inputs(), 1);

  assert.deepEqual(await session.load([READ_FILE]), {ok: true, version: 1, calls: READ_CALLS});
  assert.equal(await session.inputs(), 0, "the input leaves once the scripts have run");
  assert.deepEqual(await session.call("seEditor.layers()"), {ok: true, layers: ["minimal"]});
  assert.equal(await session.page.evaluate(() => typeof seEditor.run), "undefined", "only the read-only half is in the page before the approval");

  assert.equal((await session.call(`seEditor.use(${JSON.stringify(plan)})`)).ok, true);
  assert.equal((await session.call(LOAD)).ok, true, "pasted again, it takes the writing half");
  const answer = await session.load([UPDATE_FILE]);
  assert.equal(answer.ok, true);
  assert.ok(answer.calls.includes("await run([names])"));
  assert.equal((await upload(session)).ok, true);
  assert.equal((await session.call("seEditor.run(['minimal'])")).ok, true);
  assert.deepEqual(codeOf(await session.state(), "minimal"), normalized(NEW));
  assert.equal((await session.state()).saves, 0);
});

test("the loader takes both page scripts in one upload, whichever order they come in, and again after a reload", {timeout: 60_000}, async (t) => {
  const session = await loader(t, [widget("minimal")]);
  if (!session) return;
  assert.equal((await session.load([UPDATE_FILE, READ_FILE])).ok, true);
  assert.equal(await session.page.evaluate(() => typeof seEditor.layers + typeof seEditor.run), "functionfunction");

  await session.page.reload();
  assert.equal(await session.page.evaluate(() => typeof seEditor), "undefined", "a reload drops what was loaded");
  assert.equal((await session.call(LOAD)).ok, true);
  assert.equal((await session.load([UPDATE_FILE, READ_FILE])).ok, true);
  assert.deepEqual(await session.call("seEditor.layers()"), {ok: true, layers: ["minimal"]});
});

test("the loader adds nothing to a page that is not a StreamElements overlay editor, the Studio's among them", {timeout: 60_000}, async (t) => {
  for (const url of ["http://127.0.0.1:4310/overlay/0123456789abcdef01234567/editor", "https://streamelements.com/dashboard/overlays"]) {
    const session = await fixture(t, [widget("minimal")], {url});
    if (!session) return;
    assert.deepEqual(await session.call(LOAD), {ok: false, error: "Not an overlay editor."});
    assert.equal(await session.page.locator("#se-editor-load").count(), 0);
    assert.equal(await session.page.evaluate(() => typeof seEditorLoad), "undefined");
  }
});

test("the loader runs only the page scripts, and with none uploaded it says so and keeps its input", {timeout: 60_000}, async (t) => {
  const session = await loader(t, [widget("minimal")]);
  if (!session) return;
  assert.deepEqual(await session.call("seEditorLoad()"), NO_SCRIPT, "nothing uploaded yet");
  assert.equal(await session.inputs(), 1);

  const other = join(root, "script.js");
  await writeFile(other, "globalThis.__ran = true; JSON.stringify({ok: true});\n");
  assert.deepEqual(await session.load([other]), NO_SCRIPT);
  assert.equal(await session.inputs(), 1);
  assert.equal(await session.page.evaluate(() => globalThis.__ran), undefined, "a widget's script never runs in the editor");

  assert.equal((await session.load([other, READ_FILE])).ok, true);
  assert.equal(await session.page.evaluate(() => globalThis.__ran), undefined);
  assert.equal(await session.page.evaluate(() => typeof seEditor.layers), "function");
});

test("pasting the loader again leaves one input", {timeout: 60_000}, async (t) => {
  const session = await loader(t, [widget("minimal")]);
  if (!session) return;
  assert.equal((await session.call(LOAD)).ok, true);
  assert.equal(await session.inputs(), 1);
  assert.equal((await session.load([READ_FILE])).ok, true);
  assert.equal(await session.inputs(), 0);
});

test("a page script's refusal stops the load and comes back as it is", {timeout: 60_000}, async (t) => {
  // The loader's own check lets this address through; the strict one in se-editor-read.js refuses it.
  const session = await loader(t, [widget("minimal")], {url: `${EDITOR}/extra`});
  if (!session) return;
  assert.deepEqual(await session.load([READ_FILE, UPDATE_FILE]), {ok: false, error: "This page is not a StreamElements overlay editor. Nothing was defined."});
  assert.equal(await session.page.evaluate(() => typeof seEditor), "undefined");
  assert.equal(await session.inputs(), 1);
});

test("under a Content Security Policy that forbids eval, the load throws with nothing defined", {timeout: 60_000}, async (t) => {
  const session = await loader(t, [widget("minimal")], {headers: {"Content-Security-Policy": "script-src 'unsafe-inline'"}});
  if (!session) return;
  await session.page.getByLabel(LOADER_LABEL).setInputFiles([READ_FILE]);
  await assert.rejects(session.call("seEditorLoad()"), /EvalError|unsafe-eval/);
  assert.equal(await session.page.evaluate(() => typeof seEditor), "undefined");
  assert.equal(await session.inputs(), 1);
});
