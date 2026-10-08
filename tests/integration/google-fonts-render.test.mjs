// Hosted render path (fonts plan, stage 5): Google Fonts served from a job's font package through
// FontResolver and route.fulfill, discovery passes (FONTS_MISSING), and zero external attempts.
// The package is built here from the OFL fixture font (tests/fixtures/fonts/OFL.txt).
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import test from "node:test";
import {chromium} from "playwright-core";

import {detectBrowser} from "../../dist/capture/browser.js";
import {renderRecipe} from "../../dist/capture/renderer.js";
import {loadProject} from "../../dist/config/load.js";
import {FontResolver} from "../../dist/fonts/resolver.js";
import {captureHostSettle, captureHostUpdateFields, openScene, runBrowserSmoke} from "../../dist/scenarios/runner.js";
import {startStudioServer} from "../../dist/server/server.js";
import {startSink} from "./sink-proxy.mjs";

const fixtures = fileURLToPath(new URL("../fixtures/fonts/", import.meta.url));
const FONT_400 = await readFile(join(fixtures, "Unbounded-400.woff2"));
const FONT_700 = await readFile(join(fixtures, "Unbounded-700.woff2"));
const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

const css2 = (family) => `https://fonts.googleapis.com/css2?family=${family.replace(/ /g, "+")}`;
const fileUrl = (family) => `https://fonts.gstatic.com/s/${family.toLowerCase().replace(/ /g, "")}/v1/${family.toLowerCase().replace(/ /g, "-")}.woff2`;
const FACES = {Unbounded: FONT_400, "Studio Display": FONT_700};
const LOCAL_FACES_CSS =
  "@font-face{font-family:'Unbounded';font-weight:400;src:url(fonts/unbounded.woff2) format('woff2')}\n" +
  "@font-face{font-family:'Studio Display';font-weight:400;src:url(fonts/display.woff2) format('woff2')}\n";

/** Writes a job font package (lock-1.json and objects/) holding `families`, plus recorded 4xx `refused` URLs. */
async function fontPackage(t, {families = Object.keys(FACES), refused = []} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "sws-font-package-"));
  t.after(() => rm(directory, {recursive: true, force: true}));
  await mkdir(join(directory, "objects"));
  const entries = [];
  const put = async (url, body, contentType) => {
    await writeFile(join(directory, "objects", sha256(body)), body);
    entries.push({url, status: 200, sha256: sha256(body), bytes: body.length, contentType});
  };
  for (const family of families) {
    const css = Buffer.from(`@font-face {\n  font-family: '${family}';\n  font-style: normal;\n  font-weight: 400;\n  src: url(${fileUrl(family)}) format('woff2');\n}\n`);
    await put(css2(family), css, "text/css");
    await put(fileUrl(family), FACES[family], "font/woff2");
  }
  for (const url of refused) entries.push({url, status: 400});
  await writeFile(join(directory, "lock-1.json"), JSON.stringify({version: 1, epoch: "v1", userAgent: "fixture-agent", entries}));
  return {directory, load: () => FontResolver.load(directory, 1)};
}

async function fontWidget(t, {html, css = "", js = "", fields = {}, scenes = [{}]}) {
  const root = await mkdtemp(join(tmpdir(), "sws-google-render-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(join(root, "fonts"));
  await Promise.all([
    writeFile(join(root, "fonts/unbounded.woff2"), FONT_400),
    writeFile(join(root, "fonts/display.woff2"), FONT_700),
    writeFile(join(root, "widget.html"), html),
    writeFile(join(root, "widget.css"), `html,body{margin:0;background:transparent}\n${css}`),
    writeFile(join(root, "widget.js"), js),
    writeFile(join(root, "widget.json"), JSON.stringify(fields))
  ]);
  const project = await loadProject({inputDirectory: root});
  scenes.forEach((scene, index) => {
    const id = index === 0 ? "still" : `still-${index}`;
    project.scenes.push({
      id,
      filePath: "",
      value: {schemaVersion: 1, id, name: id, viewport: {width: 320, height: 120}, output: {width: 320, height: 120, format: "png"}, background: {id: "dark", color: "#10172b"}, ...scene}
    });
  });
  const outputRoot = await mkdtemp(join(tmpdir(), "sws-google-render-out-"));
  t.after(() => rm(outputRoot, {recursive: true, force: true}));
  return {project, outputRoot};
}

const recipe = (scenes, outputs = {screenshots: true}) => ({schemaVersion: 1, id: "fonts", name: "Fonts", scenes, outputs});
const VIDEO = {screenshots: false, video: {enabled: true, durationMs: 200, fps: 10, format: "mp4", codec: "h264", pixelFormat: "yuv420p", audio: "none"}};

async function render(context, widget, fonts, recipeValue = recipe(["still"])) {
  const result = await renderRecipe(widget.project, recipeValue, {
    outputRoot: widget.outputRoot,
    browserPath: context.browserPath,
    ffmpegPath: join(widget.outputRoot, "missing-ffmpeg"),
    allowIntermediate: true,
    ...(fonts ? {fonts} : {})
  });
  return JSON.parse(await readFile(result.manifestPath, "utf8"));
}

async function browserContext(t) {
  const detection = await detectBrowser();
  if (!detection.executablePath) {
    t.skip("No compatible local Chromium executable is installed; the Studio must not download one implicitly.");
    return undefined;
  }
  return {browserPath: detection.executablePath};
}

const TITLE_CSS = "h1{margin:0;padding:24px 12px;font:400 40px/1 monospace;color:#fff}";
// se-windows: one <link> the widget re-points in setFont(), applied on load and on every update,
// so the first call re-assigns the href the page already has.
const SET_FONT_JS = `
window.loads = 0;
const link = document.getElementById("gf");
link.addEventListener("load", () => { window.loads += 1; });
function setFont(name) {
  link.href = "https://fonts.googleapis.com/css2?family=" + encodeURIComponent(name).replace(/%20/g, "+");
  document.getElementById("t").style.fontFamily = "'" + name + "', monospace";
}
window.addEventListener("onWidgetLoad", (event) => setFont(event.detail.fieldData.font));
window.addEventListener("onWidgetUpdate", (event) => setFont(event.detail.fieldData.font));
`;
const FONT_FIELD = {font: {type: "googleFont", label: "Font", value: "Unbounded"}};

test("se-windows pattern: static link plus setFont() re-assigning the same href renders from the package without hanging", {timeout: 180_000}, async (t) => {
  const context = await browserContext(t);
  if (!context) return;
  const google = await fontWidget(t, {html: `<link id="gf" rel="stylesheet" href="${css2("Unbounded")}"><h1 id="t">Studio</h1>`, css: TITLE_CSS, js: SET_FONT_JS, fields: FONT_FIELD});
  const reference = await fontWidget(t, {html: "<h1 style=\"font-family:'Unbounded'\">Studio</h1>", css: `${LOCAL_FACES_CSS}${TITLE_CSS}`});
  const fallback = await fontWidget(t, {html: "<h1>Studio</h1>", css: TITLE_CSS});
  const pkg = await fontPackage(t);
  const fonts = await pkg.load();
  const started = Date.now();
  const served = await render(context, google, fonts);
  assert.ok(Date.now() - started < 30_000, "the same-href re-assignment does not wait for a load that never fires");
  const expected = await render(context, reference);
  const withoutFont = await render(context, fallback);
  assert.notEqual(withoutFont.artifacts[0].hashes.screenshot, expected.artifacts[0].hashes.screenshot);
  assert.equal(served.artifacts[0].hashes.screenshot, expected.artifacts[0].hashes.screenshot);
  assert.equal(served.fonts.mode, "cache");
  assert.equal(served.fonts.userAgent, "fixture-agent");
  assert.deepEqual(served.fonts.served.map(({url, status}) => [url, status]), [[css2("Unbounded"), 200], [fileUrl("Unbounded"), 200]]);
  assert.deepEqual(served.fonts.issues, []);

  // A family change through updateFields, then re-applying it, through the package: one load each time.
  const {browser} = await (await import("../../dist/capture/browser.js")).launchStudioBrowser({browserPath: context.browserPath});
  const server = await startStudioServer(google.project, {port: 0, watch: false});
  try {
    const opened = await openScene(google.project, server, browser, google.project.scenes[0].value, {fonts});
    try {
      const report = await captureHostUpdateFields(opened.page, {font: "Studio Display"});
      assert.equal(report.families.find((entry) => entry.family === "Studio Display")?.status, "loaded");
      const frame = opened.frame();
      const before = await frame.evaluate(() => window.loads);
      const again = Date.now();
      await captureHostUpdateFields(opened.page, {font: "Studio Display"});
      await captureHostSettle(opened.page);
      assert.ok(Date.now() - again < 5_000);
      assert.equal((await frame.evaluate(() => window.loads)) - before, 1, "exactly one load for the re-assigned href");
    } finally {
      await opened.context.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
});

test("glossy pattern: a link created by JS, and a protocol-relative //fonts… URL, load from the package", {timeout: 180_000}, async (t) => {
  const context = await browserContext(t);
  if (!context) return;
  const created = await fontWidget(t, {
    html: "<h1 style=\"font-family:'Unbounded'\">Studio</h1>",
    css: TITLE_CSS,
    js: `window.addEventListener("onWidgetLoad", () => { const link = document.createElement("link"); link.rel = "stylesheet"; link.href = ${JSON.stringify(css2("Unbounded"))}; document.head.append(link); });`
  });
  const relativeWidget = () => fontWidget(t, {html: `<link rel="stylesheet" href="//fonts.googleapis.com/css2?family=Unbounded"><h1 style="font-family:'Unbounded'">Studio</h1>`, css: TITLE_CSS});
  const relative = await relativeWidget();
  const reference = await fontWidget(t, {html: "<h1 style=\"font-family:'Unbounded'\">Studio</h1>", css: `${LOCAL_FACES_CSS}${TITLE_CSS}`});
  const pkg = await fontPackage(t);
  const expected = (await render(context, reference)).artifacts[0].hashes.screenshot;
  for (const widget of [created, relative]) {
    const manifest = await render(context, widget, await pkg.load());
    assert.equal(manifest.artifacts[0].hashes.screenshot, expected);
    assert.equal(manifest.artifacts[0].fonts.families.find((entry) => entry.family === "Unbounded")?.status, "loaded");
    // The frame is served over loopback HTTP, so //fonts… is http://fonts…; it is recorded canonically.
    assert.deepEqual(manifest.fonts.served.map(({url}) => url), [css2("Unbounded"), fileUrl("Unbounded")]);
  }
  // The local CLI has no package: the same widget is blocked with FONT_UNAVAILABLE and a hint, not a CSP error.
  await assert.rejects(render(context, await relativeWidget()), (error) => {
    assert.equal(error.code, "FONT_UNAVAILABLE");
    assert.match(error.message, /"Unbounded" \(http:\/\/fonts\.googleapis\.com\/css2\?family=Unbounded\)/);
    assert.doesNotMatch(error.message, /content security policy/);
    assert.match(error.hint, /hosted Studio/);
    return true;
  });
});

// se-windows 21-listing-tutorial: in tutorial mode the widget frame sits inside the editor replica,
// and its Google Fonts come from the package as in stage mode (the job failed with FONT_SETTLE_TIMEOUT).
const tutorialVideo = (widget) => ({
  screenshots: false,
  video: {
    ...VIDEO.video,
    mode: "tutorial",
    durationMs: 1000,
    fps: 2,
    tutorial: {overlayName: "Fonts overlay", layerName: "Fonts", widget, autoZoom: false, steps: [{action: "wait", ms: 200}]}
  }
});
// se-windows: the script creates the font link at startup, then onWidgetLoad applies the field's font.
const SCRIPT_LINK_JS = `
const link = document.createElement("link");
link.id = "widget-font";
link.rel = "stylesheet";
document.head.appendChild(link);
function setFont(name) {
  const href = "https://fonts.googleapis.com/css2?family=" + encodeURIComponent(name).replace(/%20/g, "+");
  if (link.href !== href) link.href = href;
  document.getElementById("t").style.fontFamily = "'" + name + "', monospace";
}
setFont("Unbounded");
window.addEventListener("onWidgetLoad", (event) => setFont(event.detail.fieldData.font));
`;

test("tutorial mode serves the widget's Google Fonts from the package: a static link, and se-windows' script link", {timeout: 180_000}, async (t) => {
  const context = await browserContext(t);
  if (!context) return;
  const pkg = await fontPackage(t);
  const cases = [
    {
      widget: await fontWidget(t, {html: `<link rel="stylesheet" href="${css2("Unbounded")}"><h1 style="font-family:'Unbounded'">Studio</h1>`, css: TITLE_CSS, scenes: [{output: {width: 1280, height: 720, format: "png"}}]}),
      placement: {x: 640, y: 360, scale: 1}
    },
    {
      widget: await fontWidget(t, {
        html: '<h1 id="t">Studio</h1>',
        css: TITLE_CSS,
        js: SCRIPT_LINK_JS,
        fields: FONT_FIELD,
        scenes: [{viewport: {width: 960, height: 640}, output: {width: 2560, height: 1440, format: "png"}}]
      }),
      placement: {x: 960, y: 540, scale: 1.2}
    }
  ];
  for (const {widget, placement} of cases) {
    const manifest = await render(context, widget, await pkg.load(), recipe(["still"], tutorialVideo(placement)));
    assert.equal(manifest.artifacts[0].videoFonts.families.find((entry) => entry.family === "Unbounded")?.status, "loaded");
    assert.deepEqual(manifest.fonts.served.map(({url}) => url), [css2("Unbounded"), fileUrl("Unbounded")]);
    assert.deepEqual(manifest.fonts.issues, []);
  }
});

test("a family Google refused (recorded 400) completes with a warning", {timeout: 120_000}, async (t) => {
  const context = await browserContext(t);
  if (!context) return;
  const missing = css2("Missing Family");
  const widget = await fontWidget(t, {html: `<link rel="stylesheet" href="${missing}"><h1 style="font-family:'Missing Family'">Studio</h1>`, css: TITLE_CSS});
  const pkg = await fontPackage(t, {refused: [missing]});
  const manifest = await render(context, widget, await pkg.load());
  assert.equal(manifest.status, "final");
  assert.deepEqual(manifest.fonts.served, [{url: missing, status: 400}]);
  assert.equal(manifest.fonts.issues.length, 1);
  assert.match(manifest.fonts.issues[0], /^upstream-4xx: Google Fonts refused "Missing Family" .* with HTTP 400/);
});

test("URLs outside the package make a discovery pass: every variant runs, nothing is captured, FONTS_MISSING lists them all", {timeout: 180_000}, async (t) => {
  const context = await browserContext(t);
  if (!context) return;
  // Each scene asks for a different missing family; only a pass that keeps running every variant finds both.
  const widget = await fontWidget(t, {
    html: `<link id="gf" rel="stylesheet" href="${css2("Unbounded")}"><h1 id="t">Studio</h1>`,
    css: TITLE_CSS,
    js: SET_FONT_JS,
    fields: FONT_FIELD,
    scenes: [{fieldData: {font: "Archivo"}}, {fieldData: {font: "Roboto Mono"}}]
  });
  const pkg = await fontPackage(t);
  await assert.rejects(render(context, widget, await pkg.load(), recipe(["still", "still-1"])), (error) => {
    assert.equal(error.code, "FONTS_MISSING");
    assert.deepEqual(error.urls, [css2("Archivo"), css2("Roboto Mono")]);
    return true;
  });
  assert.deepEqual(await readdir(join(widget.outputRoot, "fonts")).catch(() => []), [], "no screenshot and no manifest");

  // Video: the pass stops taking frames at the first miss, keeps the timeline running to a second
  // miss later in the same variant, and writes no frames.json.
  const video = await fontWidget(t, {
    html: `<link id="gf" rel="stylesheet" href="${css2("Unbounded")}"><h1 id="t">Studio</h1>`,
    css: TITLE_CSS,
    js: `${SET_FONT_JS}\nwindow.addEventListener("onWidgetLoad", () => { setTimeout(() => setFont("Archivo"), 50); setTimeout(() => setFont("Roboto Mono"), 250); });`,
    fields: FONT_FIELD
  });
  await assert.rejects(render(context, video, await pkg.load(), recipe(["still"], {...VIDEO, video: {...VIDEO.video, durationMs: 400}})), (error) => {
    assert.deepEqual(error.urls, [css2("Archivo"), css2("Roboto Mono")]);
    return true;
  });
  const written = (await readdir(video.outputRoot, {recursive: true})).map(String);
  assert.deepEqual(written.filter((file) => file.endsWith(".png")).map((file) => file.split("/").pop()), ["frame-0000.png"], "only the frame before the first miss");
  assert.ok(!written.some((file) => file.endsWith("frames.json") || file.endsWith("manifest.json")), written.join(","));
});

test("the smoke run of a test job ends with FONTS_MISSING instead of a result when a font is outside the package", {timeout: 120_000}, async (t) => {
  const context = await browserContext(t);
  if (!context) return;
  const widget = await fontWidget(t, {html: `<link rel="stylesheet" href="${css2("Archivo")}"><h1 style="font-family:'Archivo'">Studio</h1>`, css: TITLE_CSS});
  const pkg = await fontPackage(t);
  await assert.rejects(runBrowserSmoke(widget.project, {browserPath: context.browserPath, fonts: await pkg.load()}), (error) => {
    assert.equal(error.code, "FONTS_MISSING");
    assert.deepEqual(error.urls, [css2("Archivo")]);
    return true;
  });
});

// se-text-widgets/magazine: fonts.load before the stylesheet exists, one draw in the next frame.
const SINGLE_DRAW_JS = (sheet) => `
window.addEventListener("onWidgetLoad", () => {
  ${sheet ? `const link = document.createElement("link"); link.rel = "stylesheet"; link.href = ${JSON.stringify(sheet)}; document.head.append(link);` : ""}
  document.fonts.load("48px Unbounded").then(() => requestAnimationFrame(draw));
});
function draw() {
  const context = document.getElementById("c").getContext("2d");
  context.fillStyle = "#fff";
  context.font = "48px Unbounded";
  context.fillText("Canvas", 10, 70);
}
`;

test("canvas text drawn once in the next frame shows the Google font through the package (route.fulfill)", {timeout: 180_000}, async (t) => {
  const context = await browserContext(t);
  if (!context) return;
  const scenes = [{captureAtMs: 100}];
  const google = await fontWidget(t, {html: '<canvas id="c" width="320" height="120"></canvas>', js: SINGLE_DRAW_JS(css2("Unbounded")), scenes});
  const reference = await fontWidget(t, {html: '<canvas id="c" width="320" height="120"></canvas>', css: LOCAL_FACES_CSS, js: SINGLE_DRAW_JS(), scenes});
  const pkg = await fontPackage(t);
  const served = await render(context, google, await pkg.load());
  const expected = await render(context, reference);
  assert.equal(served.artifacts[0].hashes.screenshot, expected.artifacts[0].hashes.screenshot);
});

test("a render served from the package makes zero external attempts, preconnect and misses included", {timeout: 180_000}, async (t) => {
  const context = await browserContext(t);
  if (!context) return;
  const widget = await fontWidget(t, {
    html: [
      '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
      `<link id="gf" rel="stylesheet" href="${css2("Unbounded")}">`,
      '<link rel="stylesheet" href="//fonts.googleapis.com/css2?family=Studio+Display">',
      '<h1 id="t">Studio</h1><p style="font-family:\'Studio Display\'">Display</p>'
    ].join(""),
    css: TITLE_CSS,
    js: `${SET_FONT_JS}\nwindow.addEventListener("onWidgetLoad", () => { const link = document.createElement("link"); link.rel = "stylesheet"; link.href = ${JSON.stringify(css2("Not In Package"))}; document.head.append(link); const image = new Image(); image.src = "https://static-cdn.jtvnw.net/emote.png"; });`,
    fields: FONT_FIELD
  });
  const sink = await startSink();
  const browser = await chromium.launch({executablePath: context.browserPath, headless: true, proxy: {server: sink.url, bypass: "<-loopback>,127.0.0.1"}, args: ["--disable-background-networking", "--disable-component-update"]});
  const server = await startStudioServer(widget.project, {port: 0, watch: false});
  const fonts = await (await fontPackage(t)).load();
  try {
    const opened = await openScene(widget.project, server, browser, widget.project.scenes[0].value, {fonts});
    try {
      await captureHostSettle(opened.page);
      await captureHostUpdateFields(opened.page, {font: "Studio Display"});
      await captureHostSettle(opened.page);
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      await opened.context.close();
    }
    assert.deepEqual(fonts.missing(), [css2("Not In Package")]);
    assert.deepEqual(fonts.served().map(({url}) => url), [css2("Studio Display"), css2("Unbounded"), fileUrl("Studio Display"), fileUrl("Unbounded")]);
    // A branded Chrome also talks to its own services (update, time, accounts) through the proxy;
    // those are the browser's, not the page's. Nothing the widget asked for may appear.
    const fromPage = sink.seen.filter((line) => /fonts\.googleapis\.com|fonts\.gstatic\.com|static-cdn\.jtvnw\.net/.test(line));
    assert.deepEqual(fromPage, [], "no request or connection for the widget left the browser");
    assert.ok(sink.seen.every((line) => !line.includes("127.0.0.1")), "the Studio servers are reached directly");
  } finally {
    await browser.close();
    await server.close();
    await sink.close();
  }
});

// Production, 2026-09-27 (job 27cbf594): the verify-hosted --fonts widget timed out in the first
// settle of pass 2 on the Sandbox's Chromium 139, which the local Chromes (154, 149) do not
// reproduce. Its one new shape was a JS-inserted Google link answered with a recorded 400.
// The runtime no longer depends on each engine's events for such a link, and a timeout names what
// it waited for.

/** A route that answers from the package, except `hang` family stylesheets, which never get an answer. */
function hangingRoute(fonts, hang) {
  return async (url) => (url.includes(`family=${hang}`) ? new Promise(() => {}) : fonts.route(url));
}

test("the verify-hosted --fonts shape: static link, setFont() at load, and a JS link to a refused family, completes with a warning", {timeout: 120_000}, async (t) => {
  const context = await browserContext(t);
  if (!context) return;
  const missing = css2("Missing Family");
  const widget = await fontWidget(t, {
    html: `<link rel="stylesheet" href="${css2("Unbounded")}"><link id="gf" rel="stylesheet" href="${css2("Unbounded")}"><h1 id="t">Studio</h1><p style="font-family:'Missing Family'">Missing</p>`,
    css: TITLE_CSS,
    js: `${SET_FONT_JS}\nwindow.addEventListener("onWidgetLoad", () => { const link = document.createElement("link"); link.rel = "stylesheet"; link.href = ${JSON.stringify(missing)}; document.head.append(link); });`,
    fields: {font: {type: "googleFont", label: "Font", value: "Studio Display"}}
  });
  const pkg = await fontPackage(t, {refused: [missing]});
  const manifest = await render(context, widget, await pkg.load());
  assert.equal(manifest.status, "final");
  assert.ok(manifest.fonts.served.some((entry) => entry.url === missing && entry.status === 400));
  assert.ok(manifest.fonts.issues.some((issue) => issue.startsWith("upstream-4xx:") && issue.includes('"Missing Family"')), manifest.fonts.issues.join("; "));
  assert.equal(manifest.artifacts[0].fonts.families.find((entry) => entry.family === "Studio Display")?.status, "loaded");
});

async function openWithShortReady(t, context, widgetOptions, openOptions) {
  const widget = await fontWidget(t, widgetOptions);
  widget.project.config.widget.ready = {timeoutMs: 2_000};
  const {launchStudioBrowser} = await import("../../dist/capture/browser.js");
  const {browser} = await launchStudioBrowser({browserPath: context.browserPath});
  const server = await startStudioServer(widget.project, {port: 0, watch: false});
  t.after(async () => {
    await browser.close();
    await server.close();
  });
  const started = Date.now();
  const opened = await openScene(widget.project, server, browser, widget.project.scenes[0].value, openOptions);
  t.after(() => opened.context.close());
  return {opened, elapsed: Date.now() - started};
}

test("a Google stylesheet whose fetch finished but whose element fires neither load nor error does not hold settle", {timeout: 120_000}, async (t) => {
  const context = await browserContext(t);
  if (!context) return;
  const missing = css2("Missing Family");
  const pkg = await fontPackage(t, {refused: [missing]});
  // Stands in for an engine that fires no event for this answer: the widget's own capture
  // listener on window swallows both, before the runtime's listeners see them.
  const {opened, elapsed} = await openWithShortReady(t, context, {
    html: '<h1 style="font-family:\'Missing Family\'">Studio</h1>',
    css: TITLE_CSS,
    js: `for (const type of ["load", "error"]) window.addEventListener(type, (event) => { if (event.target?.id === "silent") event.stopImmediatePropagation(); }, true);
window.addEventListener("onWidgetLoad", () => { const link = document.createElement("link"); link.id = "silent"; link.rel = "stylesheet"; link.href = ${JSON.stringify(missing)}; document.head.append(link); });`
  }, {fonts: await pkg.load()});
  assert.ok(elapsed < 6_000, `opened in ${elapsed} ms`);
  const report = await captureHostSettle(opened.page, 3_000);
  assert.equal(report.families.find((entry) => entry.family === "Missing Family")?.status, "fallback");
  // Ended as `settled`, never as failed: the frame cannot know the outcome, so it does not claim one.
  assert.deepEqual(report.failedStylesheets, []);
  assert.ok(opened.issues.fonts.some(({url, status}) => url === missing && status === 400), "the request log still has the 400, so the capture reports it");
});

test("a load event while the link has no sheet ends its wait", {timeout: 120_000}, async (t) => {
  const context = await browserContext(t);
  if (!context) return;
  const fonts = await (await fontPackage(t)).load();
  const {elapsed} = await openWithShortReady(t, context, {
    html: "<h1>Studio</h1>",
    css: TITLE_CSS,
    // The request never gets an answer, so only the load event can end the wait; the sheet is still
    // null. It is dispatched after the runtime's MutationObserver has started tracking the link.
    js: `window.addEventListener("onWidgetLoad", () => { const link = document.createElement("link"); link.rel = "stylesheet"; link.href = ${JSON.stringify(css2("Hanging"))}; document.head.append(link); queueMicrotask(() => link.dispatchEvent(new Event("load"))); });`
  }, {fontRoute: hangingRoute(fonts, "Hanging")});
  assert.ok(elapsed < 6_000, `opened in ${elapsed} ms`);
});

test("FONT_SETTLE_TIMEOUT names the settle phase, the stylesheet it waited for, and the request without a response", {timeout: 120_000}, async (t) => {
  const context = await browserContext(t);
  if (!context) return;
  const fonts = await (await fontPackage(t)).load();
  await assert.rejects(openWithShortReady(t, context, {
    html: "<h1>Studio</h1>",
    css: TITLE_CSS,
    js: `window.addEventListener("onWidgetLoad", () => { const link = document.createElement("link"); link.rel = "stylesheet"; link.href = ${JSON.stringify(css2("Hanging"))}; document.head.append(link); });`
  }, {fontRoute: hangingRoute(fonts, "Hanging")}), (error) => {
    assert.equal(error.code, "FONT_SETTLE_TIMEOUT");
    assert.match(error.message, /within 7000ms of real time\. Settle phase: round 1: stylesheets\./);
    assert.match(error.message, /Stylesheets without load or error: https:\/\/fonts\.googleapis\.com\/css2\?family=Hanging\./);
    assert.match(error.message, /Google Fonts requests without a response: https:\/\/fonts\.googleapis\.com\/css2\?family=Hanging\./);
    return true;
  });
});

test("switching back to a family fetched earlier shows it again at once (the fetch fallback does not cut the wait short)", {timeout: 120_000}, async (t) => {
  const context = await browserContext(t);
  if (!context) return;
  const fonts = await (await fontPackage(t)).load();
  // Studio Display is slow, so the wait for it outlives the first Unbounded fetch by far.
  const route = async (url) => {
    if (url === css2("Studio Display")) await new Promise((resolve) => setTimeout(resolve, 800));
    return fonts.route(url);
  };
  const google = await fontWidget(t, {html: `<link id="gf" rel="stylesheet" href="${css2("Unbounded")}"><h1 id="t">Studio</h1>`, css: TITLE_CSS, js: SET_FONT_JS, fields: FONT_FIELD});
  const reference = await fontWidget(t, {html: "<h1 id=\"t\" style=\"font-family:'Unbounded'\">Studio</h1>", css: `${LOCAL_FACES_CSS}${TITLE_CSS}`});
  const {launchStudioBrowser} = await import("../../dist/capture/browser.js");
  const {browser} = await launchStudioBrowser({browserPath: context.browserPath});
  const googleServer = await startStudioServer(google.project, {port: 0, watch: false});
  const referenceServer = await startStudioServer(reference.project, {port: 0, watch: false});
  const stage = async (opened) => sha256(await opened.page.locator("#capture-stage").screenshot());
  try {
    const expectedOpened = await openScene(reference.project, referenceServer, browser, reference.project.scenes[0].value);
    const expected = await stage(expectedOpened);
    await expectedOpened.context.close();
    const opened = await openScene(google.project, googleServer, browser, google.project.scenes[0].value, {fontRoute: route});
    try {
      await captureHostUpdateFields(opened.page, {font: "Studio Display"});
      await captureHostUpdateFields(opened.page, {font: "Unbounded"});
      assert.equal(await stage(opened), expected, "the frame after the update shows Unbounded again");
    } finally {
      await opened.context.close();
    }
  } finally {
    await browser.close();
    await googleServer.close();
    await referenceServer.close();
  }
});
