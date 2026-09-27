// Reapplied from the uncommitted 2026-09-25 patch (docs/plans/google-fonts.md, section 8), with the
// render path (route.fulfill) and the single synthetic load for a re-assigned href added.
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {createServer} from "node:http";
import {fileURLToPath} from "node:url";
import test from "node:test";

import {createIsolatedContext, detectBrowser, launchStudioBrowser} from "../../dist/capture/browser.js";

const distRoot = fileURLToPath(new URL("../../dist/", import.meta.url));
const RUNTIME_FILES = new Set(["/dist/runtime/frame.js", "/dist/runtime/google-fonts-url.js", "/dist/version.js"]);

/** The stylesheets a widget swaps between, served with controlled latency. */
async function sheetResponse(pathname) {
  if (pathname === "/fast.css") {
    // Cacheable like Google Fonts CSS, so a re-assigned identical href can be served from memory.
    return {status: 200, headers: {"content-type": "text/css", "cache-control": "private, max-age=86400"}, body: "p { color: rgb(255, 0, 0); }"};
  }
  if (pathname === "/slow.css") {
    await new Promise((resolve) => setTimeout(resolve, 600));
    return {status: 200, headers: {"content-type": "text/css"}, body: "p { color: rgb(0, 0, 255); }"};
  }
  return {status: 404, headers: {"content-type": "text/plain"}, body: "Not Found"};
}

// Serves the built frame runtime and the page on 127.0.0.1; the same server answers stylesheets on
// localhost, a second origin like Google Fonts CSS in a widget frame (the bug does not show same-origin).
async function startFixtureServer() {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/") {
      response.writeHead(200, {"content-type": "text/html"});
      const sheets = url.searchParams.has("same-origin") ? "" : sheetOrigin();
      response.end(`<!doctype html><link id="font" rel="stylesheet" href="${sheets}/fast.css"><p>probe</p>`);
      return;
    }
    if (RUNTIME_FILES.has(url.pathname)) {
      response.writeHead(200, {"content-type": "text/javascript"});
      response.end(await readFile(`${distRoot}${url.pathname.slice("/dist/".length)}`));
      return;
    }
    const answer = await sheetResponse(url.pathname);
    response.writeHead(answer.status, answer.headers);
    response.end(answer.body);
  });
  const sheetOrigin = () => `http://localhost:${server.address().port}`;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    sheetOrigin: sheetOrigin(),
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

/**
 * - `continue`: a Studio context that lets the second origin through with route.continue.
 * - `fulfill`: the render path. The second origin is not allowed; a page route answers it with
 *   route.fulfill, as the hosted worker answers Google Fonts, so there is no HTTP cache.
 * - `plain`: no routing at all. Chromium 154 fires no load for a re-assigned cross-origin href.
 * - `plain-same-origin`: no routing, stylesheets on the page's origin, where Chromium fires its
 *   own load for a re-assigned href, and the runtime must not add a second one.
 */
async function openPage(browser, fixture, mode) {
  if (mode.startsWith("plain")) {
    const page = await browser.newPage();
    return {page, close: () => page.close()};
  }
  const context = await createIsolatedContext({
    browser,
    allowedOrigins: mode === "continue" ? [fixture.origin, fixture.sheetOrigin] : [fixture.origin],
    viewport: {width: 400, height: 200}
  });
  const page = await context.newPage();
  if (mode === "fulfill") {
    await page.route(`${fixture.sheetOrigin}/**`, async (route) => {
      const answer = await sheetResponse(new URL(route.request().url()).pathname);
      await route.fulfill({status: answer.status, headers: answer.headers, body: answer.body});
    });
  }
  return {page, close: () => context.close()};
}

for (const mode of ["continue", "fulfill", "plain", "plain-same-origin"]) {
  test(`asset readiness waits for a stylesheet whose href a widget swaps at runtime (${mode})`, {timeout: 30_000}, async (t) => {
    if (!(await detectBrowser()).executablePath) {
      t.skip("No compatible local Chromium executable is installed; the Studio must not download one implicitly.");
      return;
    }
    const fixture = await startFixtureServer();
    const {browser} = await launchStudioBrowser({});
    try {
      const {page, close} = await openPage(browser, fixture, mode);
      try {
        const sameOrigin = mode === "plain-same-origin";
        await page.goto(sameOrigin ? `${fixture.origin}/?same-origin` : fixture.origin);
        const result = await page.evaluate(async (sheets) => {
          const {watchStylesheets, waitForStylesheets} = await import("/dist/runtime/frame.js");
          watchStylesheets();
          const link = document.getElementById("font");
          let loads = 0;
          link.addEventListener("load", () => {
            loads += 1;
          });
          const color = () => getComputedStyle(document.querySelector("p")).color;
          const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          // Like a widget switching Google Fonts: the old sheet stays attached until the new one loads.
          link.href = `${sheets}/slow.css`;
          const beforeWait = color();
          await waitForStylesheets();
          const afterSwap = color();
          // A newer href supersedes a pending one instead of waiting on a load that never fires.
          link.href = `${sheets}/slow.css?second`;
          link.href = `${sheets}/fast.css?third`;
          await waitForStylesheets();
          const afterDoubleSwap = color();
          // Re-assigning a cached URL (a widget re-applying the font it already uses) can fire the load
          // event before a MutationObserver sees the change; readiness must not wait for it forever.
          const settledOrHung = () => Promise.race([
            waitForStylesheets().then(() => "settled"),
            new Promise((resolve) => setTimeout(() => resolve("hung"), 3000))
          ]);
          await pause(300);
          const loadsBeforeSameHref = loads;
          link.href = link.href;
          const sameCachedHref = await settledOrHung();
          // Long enough for a native load from the memory cache to arrive after the synthetic one.
          await pause(800);
          const sameHrefLoads = loads - loadsBeforeSameHref;
          link.href = `${sheets}/slow.css?fourth`;
          link.href = `${sheets}/fast.css?third`;
          const cachedRoundTrip = await settledOrHung();
          link.href = `${sheets}/missing.css`;
          const failure = await waitForStylesheets().then(() => "resolved", (error) => error.message);
          return {beforeWait, afterSwap, afterDoubleSwap, sameCachedHref, sameHrefLoads, cachedRoundTrip, failure};
        }, sameOrigin ? fixture.origin : fixture.sheetOrigin);
        assert.equal(result.beforeWait, "rgb(255, 0, 0)");
        assert.equal(result.afterSwap, "rgb(0, 0, 255)");
        assert.equal(result.afterDoubleSwap, "rgb(255, 0, 0)");
        assert.equal(result.sameCachedHref, "settled");
        assert.equal(result.sameHrefLoads, 1, "a re-assigned href gives the widget exactly one load event");
        assert.equal(result.cachedRoundTrip, "settled");
        assert.match(result.failure, /^Stylesheet failed to load: .*\/missing\.css$/);
      } finally {
        await close();
      }
    } finally {
      await browser.close();
      await fixture.close();
    }
  });
}
