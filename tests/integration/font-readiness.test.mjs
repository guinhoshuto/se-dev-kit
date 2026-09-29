// Font readiness in the widget frame (fonts plan, stage 4). The OFL fixture font (Unbounded, see
// tests/fixtures/fonts/OFL.txt) reaches the frame two ways: as a widget asset on the frame origin
// (route.continue), and at Google Fonts URLs answered with route.fulfill, which is the render path:
// no HTTP cache and no native load when a widget re-assigns the same href.
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import test from "node:test";

import {detectBrowser, launchStudioBrowser} from "../../dist/capture/browser.js";
import {renderRecipe} from "../../dist/capture/renderer.js";
import {loadProject} from "../../dist/config/load.js";
import {captureHostDispatch, captureHostSettle, captureHostUpdateFields, openScene} from "../../dist/scenarios/runner.js";
import {startStudioServer} from "../../dist/server/server.js";

const fixtures = fileURLToPath(new URL("../fixtures/fonts/", import.meta.url));
const FONT_400 = await readFile(join(fixtures, "Unbounded-400.woff2"));
const FONT_700 = await readFile(join(fixtures, "Unbounded-700.woff2"));
const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

// Two families from the fixture: "Unbounded" (the 400 file) and "Studio Display" (the 700 file, declared at 400).
const GOOGLE_FACES = {
  Unbounded: {file: "unbounded/v1/unbounded-400.woff2", bytes: FONT_400},
  "Studio Display": {file: "studiodisplay/v1/studio-display.woff2", bytes: FONT_700}
};
const LOCAL_FACES_CSS =
  "@font-face{font-family:'Unbounded';font-weight:400;src:url(fonts/unbounded.woff2) format('woff2')}\n" +
  "@font-face{font-family:'Studio Display';font-weight:400;src:url(fonts/display.woff2) format('woff2')}\n";

/**
 * Answers Google Fonts URLs from the fixture, as the hosted worker answers them from its cache.
 * `slow` delays the answers for that family, so a screenshot taken without waiting shows the fallback.
 */
function fixtureFontRoute({hang, slow} = {}) {
  const requests = [];
  const route = async (url) => {
    requests.push(url);
    const parsed = new URL(url);
    if (slow && (parsed.searchParams.getAll("family").some((entry) => entry.split(":")[0] === slow) || parsed.pathname === `/s/${GOOGLE_FACES[slow].file}`)) {
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    if (parsed.hostname === "fonts.googleapis.com") {
      const families = parsed.searchParams.getAll("family").map((entry) => entry.split(":")[0]);
      if (hang && families.includes(hang)) return new Promise(() => {});
      if (families.some((family) => !GOOGLE_FACES[family])) {
        return {status: 400, contentType: "text/html", body: Buffer.from("<!doctype html><title>Error 400 (Bad Request)</title>")};
      }
      const css = families
        .map((family) => `@font-face {\n  font-family: '${family}';\n  font-style: normal;\n  font-weight: 400;\n  src: url(https://fonts.gstatic.com/s/${GOOGLE_FACES[family].file}) format('woff2');\n}\n`)
        .join("");
      return {status: 200, contentType: "text/css; charset=utf-8", body: Buffer.from(css)};
    }
    const face = Object.values(GOOGLE_FACES).find((entry) => parsed.pathname === `/s/${entry.file}`);
    return face ? {status: 200, contentType: "font/woff2", body: face.bytes} : undefined;
  };
  return {route, requests};
}

async function fontWidget(t, {html, css = "", js = "", fields = {}, scene = {}}) {
  const root = await mkdtemp(join(tmpdir(), "sws-font-readiness-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(join(root, "fonts"));
  await Promise.all([
    writeFile(join(root, "fonts/unbounded.woff2"), FONT_400),
    writeFile(join(root, "fonts/display.woff2"), FONT_700),
    writeFile(join(root, "fonts/unbounded.css"), "@font-face{font-family:'Unbounded';font-weight:400;src:url(unbounded.woff2) format('woff2')}\n"),
    writeFile(join(root, "widget.html"), html),
    writeFile(join(root, "widget.css"), `html,body{margin:0;background:transparent}\n${css}`),
    writeFile(join(root, "widget.js"), js),
    writeFile(join(root, "widget.json"), JSON.stringify(fields))
  ]);
  const project = await loadProject({inputDirectory: root});
  project.scenes.push({
    id: "still",
    filePath: "",
    value: {
      schemaVersion: 1,
      id: "still",
      name: "Still",
      viewport: {width: 320, height: 120},
      output: {width: 320, height: 120, format: "png"},
      background: {id: "dark", color: "#10172b"},
      ...scene
    }
  });
  const outputRoot = await mkdtemp(join(tmpdir(), "sws-font-readiness-out-"));
  t.after(() => rm(outputRoot, {recursive: true, force: true}));
  return {project, outputRoot};
}

const STILL = {schemaVersion: 1, id: "fonts-still", name: "Fonts still", scenes: ["still"], outputs: {screenshots: true}};
const VIDEO = {
  schemaVersion: 1,
  id: "fonts-video",
  name: "Fonts video",
  scenes: ["still"],
  outputs: {
    screenshots: false,
    video: {enabled: true, durationMs: 200, fps: 10, format: "mp4", codec: "h264", pixelFormat: "yuv420p", audio: "none"}
  }
};

async function render(context, widget, recipe, fontRoute) {
  const result = await renderRecipe(widget.project, recipe, {
    outputRoot: widget.outputRoot,
    browserPath: context.browserPath,
    // Frames are compared by hash; no encode is needed.
    ffmpegPath: join(widget.outputRoot, "missing-ffmpeg"),
    allowIntermediate: true,
    ...(fontRoute ? {fontRoute} : {})
  });
  const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
  return manifest.artifacts[0];
}

async function browserContext(t) {
  const detection = await detectBrowser();
  if (!detection.executablePath) {
    t.skip("No compatible local Chromium executable is installed; the Studio must not download one implicitly.");
    return undefined;
  }
  return {browserPath: detection.executablePath};
}

const GOOGLE_UNBOUNDED = "https://fonts.googleapis.com/css2?family=Unbounded";
const TITLE_CSS = "h1{margin:0;padding:24px 12px;font:400 40px/1 'Unbounded',monospace;color:#fff}";

test("DOM text in a Google Fonts family is loaded, reported, and drawn like the same face declared locally", {timeout: 180_000}, async (t) => {
  const context = await browserContext(t);
  if (!context) return;
  const google = await fontWidget(t, {html: `<link rel="stylesheet" href="${GOOGLE_UNBOUNDED}"><h1>Studio</h1>`, css: TITLE_CSS});
  const reference = await fontWidget(t, {html: "<h1>Studio</h1>", css: `${LOCAL_FACES_CSS}${TITLE_CSS}`});
  const fallback = await fontWidget(t, {html: "<h1>Studio</h1>", css: TITLE_CSS});

  const route = fixtureFontRoute();
  const served = await render(context, google, STILL, route.route);
  const expected = await render(context, reference, STILL);
  const withoutFont = await render(context, fallback, STILL);
  assert.notEqual(withoutFont.hashes.screenshot, expected.hashes.screenshot, "the fixture font changes the pixels");
  assert.equal(served.hashes.screenshot, expected.hashes.screenshot);
  const face = served.fonts.families.find((entry) => entry.family === "Unbounded");
  assert.deepEqual({status: face.status, weight: face.weight, style: face.style, url: face.url}, {status: "loaded", weight: "400", style: "normal", url: GOOGLE_UNBOUNDED});
  assert.deepEqual(face.sources, ["dom", "google"]);
  assert.ok(route.requests.some((url) => url.startsWith("https://fonts.gstatic.com/s/unbounded/")), "the face came through route.fulfill");
});

// se-text-widgets/magazine: the widget calls fonts.load before its Google stylesheet exists and
// draws once, in the next animation frame. fastForward fires that frame once; without preloading
// the families of the Google URL, it draws the fallback.
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
// A widget that draws at once, in fallback, and again in every animation frame.
const LOOP_DRAW_JS = (sheet) => `
window.addEventListener("onWidgetLoad", () => {
  ${sheet ? `const link = document.createElement("link"); link.rel = "stylesheet"; link.href = ${JSON.stringify(sheet)}; document.head.append(link);` : ""}
  const frame = () => { draw(); requestAnimationFrame(frame); };
  ${sheet ? "draw();" : ""}
  requestAnimationFrame(frame);
});
function draw() {
  const canvas = document.getElementById("c");
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#fff";
  context.font = "48px Unbounded";
  context.fillText("Canvas", 10, 70);
}
`;
const CANVAS_HTML = '<canvas id="c" width="320" height="120"></canvas>';

test("canvas text drawn once in the next frame shows the Google font in stills and video (route.fulfill)", {timeout: 240_000}, async (t) => {
  const context = await browserContext(t);
  if (!context) return;
  const scene = {captureAtMs: 100};
  const google = await fontWidget(t, {html: CANVAS_HTML, js: SINGLE_DRAW_JS(GOOGLE_UNBOUNDED), scene});
  const reference = await fontWidget(t, {html: CANVAS_HTML, css: LOCAL_FACES_CSS, js: SINGLE_DRAW_JS(), scene});

  const served = await render(context, google, STILL, fixtureFontRoute().route);
  const expected = await render(context, reference, STILL);
  assert.equal(served.hashes.screenshot, expected.hashes.screenshot);
  assert.equal(served.fonts.families.find((entry) => entry.family === "Unbounded")?.status, "loaded");

  const servedVideo = await render(context, google, VIDEO, fixtureFontRoute().route);
  const expectedVideo = await render(context, reference, VIDEO);
  const [first, second] = [servedVideo.frameSequence.frames, expectedVideo.frameSequence.frames];
  assert.equal(first.length, 2);
  assert.equal(first[1].timestampMs, 100);
  assert.equal(first[1].sha256, second[1].sha256, "the frame at 100 ms draws the canvas with the font");
  assert.equal(servedVideo.videoFonts.families.find((entry) => entry.family === "Unbounded")?.status, "loaded");
});

for (const path of ["fulfill", "continue"]) {
  test(`canvas text drawn in fallback is redrawn one frame later before the still (${path})`, {timeout: 180_000}, async (t) => {
    const context = await browserContext(t);
    if (!context) return;
    const google = await fontWidget(t, {html: CANVAS_HTML, js: LOOP_DRAW_JS(path === "fulfill" ? GOOGLE_UNBOUNDED : "fonts/unbounded.css")});
    const reference = await fontWidget(t, {html: CANVAS_HTML, css: LOCAL_FACES_CSS, js: LOOP_DRAW_JS(), scene: {captureAtMs: 16}});
    await writeFile(join(reference.project.widgetRoot, "widget.js"), `${LOOP_DRAW_JS()}\ndocument.fonts.load("48px Unbounded");\n`);

    const served = await render(context, google, STILL, path === "fulfill" ? fixtureFontRoute().route : undefined);
    const expected = await render(context, reference, STILL);
    assert.equal(served.fonts.redrawMs, 16);
    assert.equal(served.hashes.screenshot, expected.hashes.screenshot);
    assert.equal(served.fonts.families.find((entry) => entry.family === "Unbounded")?.status, "loaded");
  });
}

// se-windows: setFont() re-points one <link> and the text's family; re-applying the current font
// re-assigns the same href, which fires no native load under route.fulfill.
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

test("a family change through updateFields shows at once, and re-applying it gives one load (route.fulfill)", {timeout: 180_000}, async (t) => {
  const context = await browserContext(t);
  if (!context) return;
  const css = "h1{margin:0;padding:24px 12px;font:400 40px/1 monospace;color:#fff}";
  const google = await fontWidget(t, {
    html: `<link id="gf" rel="stylesheet" href="${GOOGLE_UNBOUNDED}"><h1 id="t">Studio</h1>`,
    css,
    js: SET_FONT_JS,
    fields: {font: {type: "googleFont", label: "Font", value: "Unbounded"}}
  });
  const reference = await fontWidget(t, {html: '<h1 id="t" style="font-family:\'Studio Display\'">Studio</h1>', css: `${LOCAL_FACES_CSS}${css}`});
  const {browser} = await launchStudioBrowser({browserPath: context.browserPath});
  const googleServer = await startStudioServer(google.project, {port: 0, watch: false});
  const referenceServer = await startStudioServer(reference.project, {port: 0, watch: false});
  const stage = (opened) => opened.page.locator("#capture-stage").screenshot();
  try {
    const expectedOpened = await openScene(reference.project, referenceServer, browser, reference.project.scenes[0].value);
    const expected = sha256(await stage(expectedOpened));
    await expectedOpened.context.close();

    const opened = await openScene(google.project, googleServer, browser, google.project.scenes[0].value, {fontRoute: fixtureFontRoute({slow: "Studio Display"}).route});
    try {
      const report = await captureHostUpdateFields(opened.page, {font: "Studio Display"});
      assert.equal(report.families.find((entry) => entry.family === "Studio Display")?.status, "loaded");
      // No clock advance: the next frame after the update already has the new family.
      assert.equal(sha256(await stage(opened)), expected);
      const frame = opened.frame();
      const loadsBefore = await frame.evaluate(() => window.loads);
      const started = Date.now();
      await captureHostUpdateFields(opened.page, {font: "Studio Display"});
      assert.ok(Date.now() - started < 5_000, "re-applying the same font does not wait for a load that never fires");
      await captureHostSettle(opened.page);
      assert.equal((await frame.evaluate(() => window.loads)) - loadsBefore, 1, "exactly one load for the re-assigned href");
    } finally {
      await opened.context.close();
    }
  } finally {
    await browser.close();
    await googleServer.close();
    await referenceServer.close();
  }
});

test("a stylesheet a timer swaps mid-video is settled before the next frame is taken (route.fulfill)", {timeout: 180_000}, async (t) => {
  const context = await browserContext(t);
  if (!context) return;
  const css = "h1{margin:0;padding:24px 12px;font:400 40px/1 monospace;color:#fff}";
  // Nothing but a timer changes the font: no event runs a settle before the frame at 100 ms.
  const google = await fontWidget(t, {
    html: `<link id="gf" rel="stylesheet" href="${GOOGLE_UNBOUNDED}"><h1 id="t" style="font-family:'Unbounded'">Studio</h1>`,
    css,
    js: `window.addEventListener("onWidgetLoad", () => setTimeout(() => {
  document.getElementById("gf").href = "https://fonts.googleapis.com/css2?family=Studio+Display";
  document.getElementById("t").style.fontFamily = "'Studio Display'";
}, 50));`
  });
  const reference = await fontWidget(t, {html: '<h1 id="t" style="font-family:\'Studio Display\'">Studio</h1>', css: `${LOCAL_FACES_CSS}${css}`});
  const served = await render(context, google, VIDEO, fixtureFontRoute({slow: "Studio Display"}).route);
  const expected = await render(context, reference, VIDEO);
  assert.equal(served.frameSequence.frames[1].sha256, expected.frameSequence.frames[1].sha256);
});

// se-windows: the widget applies its default font at startup, then onWidgetLoad points the same link
// at the theme's font while the default is still loading. Chrome aborts the default's request
// (net::ERR_ABORTED); the document no longer uses it, so it is not an unavailable font.
test("a Google Fonts stylesheet the widget swaps away while it loads is not FONT_UNAVAILABLE (route.fulfill)", {timeout: 180_000}, async (t) => {
  const context = await browserContext(t);
  if (!context) return;
  const css = "h1{margin:0;padding:24px 12px;font:400 40px/1 monospace;color:#fff}";
  const google = await fontWidget(t, {
    html: '<h1 id="t">Studio</h1>',
    css,
    js: `const link = document.createElement("link");
link.rel = "stylesheet";
link.href = "${GOOGLE_UNBOUNDED}";
document.head.append(link);
document.getElementById("t").style.fontFamily = "'Unbounded', monospace";
window.addEventListener("onWidgetLoad", () => {
  link.href = "https://fonts.googleapis.com/css2?family=Studio+Display";
  document.getElementById("t").style.fontFamily = "'Studio Display', monospace";
});`
  });
  const reference = await fontWidget(t, {html: '<h1 id="t" style="font-family:\'Studio Display\'">Studio</h1>', css: `${LOCAL_FACES_CSS}${css}`});
  const route = fixtureFontRoute({slow: "Unbounded"});
  const served = await render(context, google, STILL, route.route);
  const expected = await render(context, reference, STILL);
  assert.ok(route.requests.includes(GOOGLE_UNBOUNDED), "the default font was requested before the swap");
  assert.equal(served.hashes.screenshot, expected.hashes.screenshot);
  assert.equal(served.fonts.families.find((entry) => entry.family === "Studio Display")?.status, "loaded");
});

test("a settle past its real-time deadline fails with FONT_SETTLE_TIMEOUT instead of hanging", {timeout: 120_000}, async (t) => {
  const context = await browserContext(t);
  if (!context) return;
  const widget = await fontWidget(t, {
    html: "<h1>Studio</h1>",
    js: 'window.addEventListener("onEventReceived", () => { const link = document.createElement("link"); link.rel = "stylesheet"; link.href = "https://fonts.googleapis.com/css2?family=Hanging"; document.head.append(link); });'
  });
  const {browser} = await launchStudioBrowser({browserPath: context.browserPath});
  const server = await startStudioServer(widget.project, {port: 0, watch: false});
  try {
    const opened = await openScene(widget.project, server, browser, widget.project.scenes[0].value, {fontRoute: fixtureFontRoute({hang: "Hanging"}).route});
    try {
      let started = Date.now();
      await assert.rejects(captureHostDispatch(opened.page, "message", {data: {text: "hi"}}, 1_500), {code: "FONT_SETTLE_TIMEOUT"});
      assert.ok(Date.now() - started < 4_500);
      started = Date.now();
      await assert.rejects(captureHostSettle(opened.page, 1_000), {code: "FONT_SETTLE_TIMEOUT"});
      assert.ok(Date.now() - started < 4_000);
    } finally {
      await opened.context.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
});

test("Google Fonts outcomes: blocked is FONT_UNAVAILABLE, a refused family is a warning, /icon is FONT_UNSUPPORTED", {timeout: 180_000}, async (t) => {
  const context = await browserContext(t);
  if (!context) return;
  const blocked = await fontWidget(t, {html: `<link rel="stylesheet" href="${GOOGLE_UNBOUNDED}"><h1>Studio</h1>`, css: TITLE_CSS});
  await assert.rejects(render(context, blocked, STILL), (error) => {
    assert.equal(error.code, "FONT_UNAVAILABLE");
    assert.match(error.message, /"Unbounded" \(https:\/\/fonts\.googleapis\.com\/css2\?family=Unbounded\)/);
    assert.match(error.hint, /hosted Studio/);
    return true;
  });

  const refused = await fontWidget(t, {
    html: '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Missing+Family"><h1 style="font-family:\'Missing Family\'">Studio</h1>'
  });
  const entry = await render(context, refused, STILL, fixtureFontRoute().route);
  assert.equal(entry.fonts.warnings.length, 1);
  assert.match(entry.fonts.warnings[0], /^upstream-4xx: Google Fonts refused "Missing Family" .* with HTTP 400/);
  assert.deepEqual(
    entry.fonts.families.map(({family, weight, status, reason, sources}) => ({family, weight, status, reason, sources})),
    [
      {family: "Missing Family", weight: "400", status: "fallback", reason: "stylesheet-blocked", sources: ["google"]},
      // The <h1> is bold by default.
      {family: "Missing Family", weight: "700", status: "fallback", reason: "stylesheet-blocked", sources: ["dom"]}
    ]
  );

  const icon = await fontWidget(t, {html: '<link rel="stylesheet" href="https://fonts.googleapis.com/icon?family=Material+Icons"><h1>Studio</h1>'});
  await assert.rejects(render(context, icon, STILL), {code: "FONT_UNSUPPORTED"});
});

// The editor preview runs with real timers: its frame keeps a font budget of its own and reports a
// family still loading when it expires as fallback (timeout), and a Google stylesheet its CSP
// refuses as fallback (stylesheet-blocked), instead of failing the preview.
test("with real timers, settle reports a CSP-refused stylesheet and an expired font budget as fallback", {timeout: 60_000}, async (t) => {
  const context = await browserContext(t);
  if (!context) return;
  const distRoot = fileURLToPath(new URL("../../dist/", import.meta.url));
  const {createServer} = await import("node:http");
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (["/dist/runtime/frame.js", "/dist/runtime/google-fonts-url.js", "/dist/version.js"].includes(url.pathname)) {
      response.writeHead(200, {"content-type": "text/javascript"});
      response.end(await readFile(`${distRoot}${url.pathname.slice("/dist/".length)}`));
      return;
    }
    const csp = url.pathname === "/csp" ? `<meta http-equiv="Content-Security-Policy" content="style-src 'self' 'unsafe-inline'">` : "";
    response.writeHead(200, {"content-type": "text/html"});
    response.end(`<!doctype html>${csp}<p style="font-family:'Probe Face',monospace">Probe</p>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const {browser} = await launchStudioBrowser({browserPath: context.browserPath});
  const probe = (budgetMs) => async ({budget}) => {
    const {watchStylesheets, settle} = await import("/dist/runtime/frame.js");
    watchStylesheets();
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Probe+Face";
    document.head.append(link);
    const started = performance.now();
    const report = await settle({budgetMs: budget});
    return {report, elapsed: performance.now() - started};
  };
  try {
    const refused = await browser.newPage();
    await refused.goto(`${origin}/csp`);
    const csp = await refused.evaluate(probe(), {budget: 5_000});
    assert.equal(csp.report.complete, true);
    assert.deepEqual(csp.report.families.map(({family, status, reason}) => ({family, status, reason})), [{family: "Probe Face", status: "fallback", reason: "stylesheet-blocked"}]);
    assert.deepEqual(csp.report.failedStylesheets, [{href: "https://fonts.googleapis.com/css2?family=Probe+Face", reason: "stylesheet-blocked"}]);
    assert.ok(csp.report.issues.some((issue) => /^Content security policy refused https:\/\/fonts\.googleapis\.com\//.test(issue)), csp.report.issues.join("; "));

    const hanging = await browser.newPage();
    await hanging.route("https://fonts.googleapis.com/**", () => {});
    await hanging.goto(`${origin}/`);
    const expired = await hanging.evaluate(probe(), {budget: 800});
    assert.equal(expired.report.complete, false);
    assert.ok(expired.elapsed >= 750 && expired.elapsed < 3_000, `settled after ${expired.elapsed} ms`);
    assert.deepEqual(expired.report.families.map(({family, status, reason}) => ({family, status, reason})), [{family: "Probe Face", status: "fallback", reason: "timeout"}]);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
