// A capture's fake clock starts every document at the scene's fixed time: `performance.now()` at 0 and
// `performance.timeOrigin` at that time, however long the host took to load and however late the
// document first asks the clock. Before #5 the widget frame's `performance.now()` started at the real
// time between the clock's `install` and its pause (36–1782 ms), or at the 101 ms its own timer added
// when the frame's scripts came late, so two captures of a canvas widget drew different frames.
import assert from "node:assert/strict";
import {createServer} from "node:http";
import test from "node:test";

import {createIsolatedContext, detectBrowser, launchStudioBrowser} from "../../dist/capture/browser.js";
import {pauseClockFromStart} from "../../dist/scenarios/runner.js";

const FIXED_TIME = new Date("2025-01-15T12:00:00.000Z");
// Longer than the clock's own 100 ms timer, three times over.
const LATE_MS = 400;
const READ_CLOCK = "<script>window.atStart = {now: performance.now(), date: Date.now(), timeOrigin: performance.timeOrigin};</script>";
const PAGES = {
  "/host.html": "<!doctype html><body></body>",
  "/early.html": `<!doctype html>${READ_CLOCK}`,
  // A script after a stylesheet waits for it: the document's first clock call comes after LATE_MS.
  "/late.html": `<!doctype html><link rel="stylesheet" href="/slow.css">${READ_CLOCK}`
};

/** Serves the pages above, and /slow.css after LATE_MS, on 127.0.0.1. */
async function startServer() {
  const server = createServer((request, response) => {
    const {pathname} = new URL(request.url, "http://127.0.0.1");
    if (pathname === "/slow.css") {
      setTimeout(() => {
        response.writeHead(200, {"content-type": "text/css"});
        response.end("body { margin: 0; }");
      }, LATE_MS);
      return;
    }
    if (!Object.hasOwn(PAGES, pathname)) {
      response.writeHead(404, {"content-type": "text/plain"});
      response.end("Not Found");
      return;
    }
    response.writeHead(200, {"content-type": "text/html"});
    response.end(PAGES[pathname]);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

/** Adds an iframe of `path` to the host and returns what its first script read from the clock. */
async function frameClock(page, origin, path) {
  await page.evaluate((src) => new Promise((resolve) => {
    const frame = document.createElement("iframe");
    frame.addEventListener("load", resolve, {once: true});
    frame.src = src;
    document.body.append(frame);
  }), `${origin}${path}`);
  return page.frames().find((frame) => frame.url().endsWith(path)).evaluate(() => window.atStart);
}

test("a capture's clock starts every document at the fixed time, however late the document first asks it", {timeout: 60_000}, async (t) => {
  if (!(await detectBrowser()).executablePath) {
    t.skip("No compatible local Chromium executable is installed; the Studio must not download one implicitly.");
    return;
  }
  const server = await startServer();
  const {browser} = await launchStudioBrowser({});
  try {
    const context = await createIsolatedContext({browser, allowedOrigins: [server.origin], viewport: {width: 320, height: 240}});
    try {
      const page = await context.newPage();
      await pauseClockFromStart(page, FIXED_TIME);
      await page.goto(`${server.origin}/host.html`, {waitUntil: "domcontentloaded"});
      // Real time passes between the clock's first call and the widget frame, as the capture host loads.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const early = await frameClock(page, server.origin, "/early.html");
      const late = await frameClock(page, server.origin, "/late.html");
      t.diagnostic(`early ${JSON.stringify(early)}; late ${JSON.stringify(late)}`);

      const expected = {now: 0, date: FIXED_TIME.getTime(), timeOrigin: FIXED_TIME.getTime()};
      assert.deepEqual(early, expected, "a frame created after the host loaded starts at the fixed time");
      assert.deepEqual(late, expected, `a frame that first asks the clock ${LATE_MS} ms after it was created starts at the fixed time`);
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
});
