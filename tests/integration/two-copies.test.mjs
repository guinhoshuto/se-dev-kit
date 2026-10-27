// Two copies of one widget, the second loaded 700 ms after the first, must draw the same frame at the
// same instant: a layered setup (a back copy under the camera, a front copy over it) is two OBS browser
// sources, and OBS never loads them at the same moment. A Studio capture cannot show this: it loads one
// copy on a fixed clock. Ported from the check that proved the se-curvetext clock fix on 2026-10-14
// (SDK-51): with the fix the copies differed by 0.0005, without it by 29.4.
// The layers' two Studio captures must match too. Until #5 they did not, on either clock expression:
// the widget frame's `performance.now()` started at the real time the capture host took to load, which
// `performance.timeOrigin + performance.now()` kept and which moved the 16 ms requestAnimationFrame grid.
import assert from "node:assert/strict";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {createServer} from "node:http";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import test from "node:test";

import {createIsolatedContext, detectBrowser, launchStudioBrowser} from "../../dist/capture/browser.js";
import {renderRecipe} from "../../dist/capture/renderer.js";
import {loadProject} from "../../dist/config/load.js";
import {decodePng} from "../../scripts/verify-hosted.mjs";

const FIXTURE = new URL("../fixtures/two-copies/", import.meta.url);
const FILES = {
  "/host.html": "text/html",
  "/frame.html": "text/html",
  "/clock-widget.js": "text/javascript"
};
const LOAD_GAP_MS = 700;

/** Serves the three fixture files, and nothing else, on 127.0.0.1. */
async function startFixtureServer() {
  const server = createServer(async (request, response) => {
    const {pathname} = new URL(request.url, "http://127.0.0.1");
    if (!Object.hasOwn(FILES, pathname)) {
      response.writeHead(404, {"content-type": "text/plain"});
      response.end("Not Found");
      return;
    }
    response.writeHead(200, {"content-type": FILES[pathname]});
    response.end(await readFile(new URL(`.${pathname}`, FIXTURE)));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

/** Loads the frame into #a, then 700 ms later into #b, and compares both canvases in one task. */
async function compareCopies(page, frameUrl) {
  await page.evaluate(async ({frameUrl, gap}) => {
    const load = (id) => new Promise((resolve) => {
      const frame = document.getElementById(id);
      frame.addEventListener("load", resolve, {once: true});
      frame.src = frameUrl;
    });
    await load("a");
    await new Promise((resolve) => setTimeout(resolve, gap));
    await load("b");
  }, {frameUrl, gap: LOAD_GAP_MS});
  await page.waitForTimeout(500);
  return page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => setTimeout(() => {
      const read = (id) => {
        const canvas = document.getElementById(id).contentDocument.getElementById("canvas");
        return canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      };
      const a = read("a");
      const b = read("b");
      let sum = 0;
      let ink = 0;
      for (let i = 0; i < a.length; i += 1) {
        sum += Math.abs(a[i] - b[i]);
        if (i % 4 === 3 && a[i] > 0) ink += 1;
      }
      resolve({meanDiff: sum / a.length, inkShare: ink / (a.length / 4)});
    }, 0));
  }));
}

test("two copies of a widget loaded 700 ms apart draw the same frame only on the system clock", {timeout: 60_000}, async (t) => {
  if (!(await detectBrowser()).executablePath) {
    t.skip("No compatible local Chromium executable is installed; the Studio must not download one implicitly.");
    return;
  }
  const fixture = await startFixtureServer();
  const {browser} = await launchStudioBrowser({});
  try {
    const context = await createIsolatedContext({browser, allowedOrigins: [fixture.origin], viewport: {width: 960, height: 270}});
    try {
      const page = await context.newPage();
      await page.goto(`${fixture.origin}/host.html`, {waitUntil: "load"});
      const system = await compareCopies(page, `${fixture.origin}/frame.html?clock=system`);
      await page.goto(`${fixture.origin}/host.html`, {waitUntil: "load"});
      const load = await compareCopies(page, `${fixture.origin}/frame.html?clock=load`);
      t.diagnostic(`system clock ${JSON.stringify(system)}; load clock ${JSON.stringify(load)}`);

      // Mean |difference| per RGBA channel, 0..255. The se-curvetext check measured 0.17 to 0.64 in
      // sync (Date.now() has 1 ms steps) and 29.4 out of sync, and passed at 2.
      assert.ok(system.inkShare > 0.05, `the system-clock copies drew almost nothing: ${JSON.stringify(system)}`);
      assert.ok(system.meanDiff <= 2, `copies on the system clock must match: ${JSON.stringify(system)}`);
      // The scenario happened: copies that keep time from their own load are 31.5 degrees apart.
      assert.ok(load.inkShare > 0.05, `the load-clock copies drew almost nothing: ${JSON.stringify(load)}`);
      assert.ok(load.meanDiff > 2, `copies that keep time from their own load must differ: ${JSON.stringify(load)}`);
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
    await fixture.close();
  }
});

/** Mean |difference| per RGBA channel of two PNGs, 0..255, and the share of pixels the first one inks. */
function compareStills(left, right) {
  const a = decodePng(left).pixels;
  const b = decodePng(right).pixels;
  let sum = 0;
  let ink = 0;
  for (let i = 0; i < a.length; i += 1) {
    sum += Math.abs(a[i] - b[i]);
    if (i % 4 === 0 && a[i] > 0) ink += 1;
  }
  return {meanDiff: sum / a.length, inkShare: ink / (a.length / 4)};
}

test("two Studio captures of one scene draw the same frame, on either system clock expression", {timeout: 120_000}, async (t) => {
  const detection = await detectBrowser();
  if (!detection.executablePath) {
    t.skip("No compatible local Chromium executable is installed; the Studio must not download one implicitly.");
    return;
  }
  const outputRoot = await mkdtemp(join(tmpdir(), "sws-two-copies-"));
  t.after(() => rm(outputRoot, {recursive: true, force: true}));
  const project = await loadProject({inputDirectory: fileURLToPath(FIXTURE)});
  const recipe = project.recipes.find((item) => item.id === "still").value;
  // One capture per call, as each layer of a layered setup is: each scene gets its own page and clock.
  const capture = async (run) => {
    const result = await renderRecipe(project, recipe, {outputRoot: join(outputRoot, run), browserPath: detection.executablePath});
    const {artifacts} = JSON.parse(await readFile(result.manifestPath, "utf8"));
    const stills = {};
    for (const artifact of artifacts) stills[artifact.scene] = await readFile(join(outputRoot, run, artifact.files.screenshot.file));
    return stills;
  };
  const first = await capture("first");
  const second = await capture("second");
  const system = compareStills(first.system, second.system);
  const timeOrigin = compareStills(first.timeorigin, second.timeorigin);
  const apart = compareStills(first.system, first.timeorigin);
  t.diagnostic(`system clock ${JSON.stringify(system)}; timeOrigin clock ${JSON.stringify(timeOrigin)}; system against timeOrigin ${JSON.stringify(apart)}`);

  assert.ok(system.inkShare > 0.05, `the system-clock capture drew almost nothing: ${JSON.stringify(system)}`);
  assert.ok(first.system.equals(second.system), `two captures on Date.now() - performance.now() must be identical: ${JSON.stringify(system)}`);
  assert.ok(first.timeorigin.equals(second.timeorigin), `two captures on performance.timeOrigin must be identical: ${JSON.stringify(timeOrigin)}`);
  // Both read the scene's fixed time: the frame's performance.now() starts at 0, with timeOrigin there.
  assert.ok(first.system.equals(first.timeorigin), `the two clock expressions must draw the same frame: ${JSON.stringify(apart)}`);
});
