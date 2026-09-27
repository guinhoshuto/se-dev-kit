// serveFontRequest and FontResolver (fonts plan, stage 5): the hosted worker answers Google Fonts
// requests from the job's font package with route.fulfill and never reaches the network.
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp, mkdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

import {serveFontRequest} from "../../dist/capture/browser.js";
import {FontResolver, FontsMissingError, isFontsMissing, parseFontLock, servedFontsDigest} from "../../dist/fonts/resolver.js";

const sha256 = (body) => createHash("sha256").update(body).digest("hex");
const CSS_URL = "https://fonts.googleapis.com/css2?family=Unbounded";
const FILE_URL = "https://fonts.gstatic.com/s/unbounded/v1/unbounded-400.woff2";
const REFUSED_URL = "https://fonts.googleapis.com/css2?family=Missing+Family";
const OTHER_URL = "https://fonts.googleapis.com/css2?family=Archivo";
const CSS = Buffer.from(`@font-face{font-family:'Unbounded';src:url(${FILE_URL}) format('woff2')}`);
const FONT = Buffer.from("wOF2 fixture bytes");

function lock() {
  return {
    version: 1,
    epoch: "v1",
    userAgent: "test-agent",
    entries: [
      {url: CSS_URL, status: 200, sha256: sha256(CSS), bytes: CSS.length, contentType: "text/css"},
      {url: FILE_URL, status: 200, sha256: sha256(FONT), bytes: FONT.length, contentType: "font/woff2"},
      {url: REFUSED_URL, status: 400},
      // In the lock but never requested: it must stay out of what the render reports as served.
      {url: OTHER_URL, status: 400}
    ]
  };
}

function resolver(objects = {[sha256(CSS)]: CSS, [sha256(FONT)]: FONT}) {
  const reads = [];
  const instance = new FontResolver(lock(), async (digest) => {
    reads.push(digest);
    return objects[digest];
  });
  return {instance, reads};
}

/** A Playwright-like route. `continue` and `fetch` exist only to prove they are never called. */
function stubRoute(url, method = "GET") {
  const calls = [];
  return {
    calls,
    request: () => ({method: () => method, url: () => url}),
    fulfill: async (response) => void calls.push({kind: "fulfill", response}),
    abort: async (code) => void calls.push({kind: "abort", code}),
    continue: async () => void calls.push({kind: "continue"}),
    fetch: async () => void calls.push({kind: "fetch"})
  };
}

test("a hit is fulfilled with 200, its content type and the CORS header", async () => {
  const {instance} = resolver();
  const route = stubRoute(FILE_URL);
  await serveFontRequest(route, instance.route);
  assert.equal(route.calls.length, 1);
  const [{kind, response}] = route.calls;
  assert.equal(kind, "fulfill");
  assert.equal(response.status, 200);
  assert.equal(response.contentType, "font/woff2");
  assert.equal(response.headers["access-control-allow-origin"], "*");
  assert.deepEqual(Buffer.from(response.body), FONT);
});

test("a POST, or a URL outside the allowlist, is blocked without looking at the package", async () => {
  const {instance, reads} = resolver();
  for (const route of [stubRoute(CSS_URL, "POST"), stubRoute("https://fonts.googleapis.com/icon?family=Material+Icons")]) {
    await serveFontRequest(route, instance.route);
    assert.deepEqual(route.calls, [{kind: "abort", code: "blockedbyclient"}]);
  }
  assert.deepEqual(reads, []);
  assert.equal(instance.hasMissing(), false);
});

test("a recorded upstream 4xx is fulfilled with that status", async () => {
  const {instance} = resolver();
  const route = stubRoute(REFUSED_URL);
  await serveFontRequest(route, instance.route);
  assert.equal(route.calls[0].kind, "fulfill");
  assert.equal(route.calls[0].response.status, 400);
  assert.equal(instance.hasMissing(), false);
});

test("a miss is aborted as failed and recorded under its canonical URL", async () => {
  const {instance} = resolver();
  const route = stubRoute("//fonts.googleapis.com/css2?family=Roboto:wght@700".replace(/^/, "http:"));
  await serveFontRequest(route, instance.route);
  assert.deepEqual(route.calls, [{kind: "abort", code: "failed"}]);
  assert.deepEqual(instance.missing(), ["https://fonts.googleapis.com/css2?family=Roboto:wght@700"]);
  assert.equal(instance.isMissing("https://fonts.googleapis.com/css2?family=Roboto:wght@700"), true);
  assert.equal(instance.isMissing(CSS_URL), false);
});

test("an object whose bytes do not match the lock is never served", async () => {
  const {instance} = resolver({[sha256(CSS)]: Buffer.from("altered"), [sha256(FONT)]: FONT});
  const route = stubRoute(CSS_URL);
  await serveFontRequest(route, instance.route);
  assert.deepEqual(route.calls, [{kind: "abort", code: "failed"}]);
  assert.deepEqual(instance.missing(), [CSS_URL]);
});

test("it never calls continue or fetch, whatever the outcome", async () => {
  const {instance} = resolver();
  const kinds = [];
  for (const [url, method] of [[CSS_URL, "GET"], [REFUSED_URL, "GET"], [OTHER_URL.replace("Archivo", "Nope"), "GET"], [CSS_URL, "HEAD"]]) {
    const route = stubRoute(url, method);
    await serveFontRequest(route, instance.route);
    kinds.push(...route.calls.map((call) => call.kind));
  }
  assert.ok(!kinds.includes("continue") && !kinds.includes("fetch"), kinds.join(","));
  assert.deepEqual(kinds, ["fulfill", "fulfill", "abort", "abort"]);
});

test("the memo reads each object once, even for concurrent requests", async () => {
  const {instance, reads} = resolver();
  await Promise.all([1, 2, 3].map(() => serveFontRequest(stubRoute(FILE_URL), instance.route)));
  await serveFontRequest(stubRoute(FILE_URL.replace("https:", "http:")), instance.route);
  assert.deepEqual(reads, [sha256(FONT)]);
});

test("the report and its digest cover only what was served, not the whole lock", async () => {
  const {instance} = resolver();
  await serveFontRequest(stubRoute(CSS_URL), instance.route);
  await serveFontRequest(stubRoute(REFUSED_URL), instance.route);
  const report = instance.report();
  // Sorted by URL.
  assert.deepEqual(report.served, [
    {url: REFUSED_URL, status: 400},
    {url: CSS_URL, status: 200, sha256: sha256(CSS), bytes: CSS.length}
  ]);
  assert.equal(report.mode, "cache");
  assert.equal(report.epoch, "v1");
  assert.equal(report.userAgent, "test-agent");
  // Same formula as servedDigest in lib/fonts.ts: sorted JSON lines of [url, status, sha256|null].
  const expected = sha256([JSON.stringify([CSS_URL, 200, sha256(CSS)]), JSON.stringify([REFUSED_URL, 400, null])].sort().join("\n"));
  assert.equal(report.servedDigest, expected);
  assert.equal(servedFontsDigest([...report.served].reverse()), expected, "order-independent");
});

test("the resolver loads lock-<pass>.json and objects/ from a job's fonts directory", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "sws-font-route-"));
  t.after(() => rm(directory, {recursive: true, force: true}));
  await mkdir(join(directory, "objects"));
  await writeFile(join(directory, "objects", sha256(FONT)), FONT);
  await writeFile(join(directory, "lock-2.json"), JSON.stringify(lock()));
  const second = await FontResolver.load(directory, 2);
  assert.equal((await second.route(FILE_URL))?.status, 200);
  const first = await FontResolver.load(directory, 1);
  assert.equal(await first.route(FILE_URL), undefined, "no lock-1.json: an empty package");
  assert.deepEqual(first.missing(), [FILE_URL]);
});

test("lock parsing drops entries that are malformed or not canonical", () => {
  const parsed = parseFontLock({...lock(), entries: [...lock().entries, {url: "https://evil.example/css", status: 200, sha256: "0".repeat(64), bytes: 1, contentType: "text/css"}, {url: "http://fonts.googleapis.com/css2?family=Unbounded", status: 400}, {url: CSS_URL, status: 302}]});
  assert.deepEqual(parsed.entries.map((entry) => entry.url), lock().entries.map((entry) => entry.url));
  assert.throws(() => parseFontLock({entries: []}), {code: "FONT_LOCK_INVALID"});
});

test("FONTS_MISSING carries the sorted, unique list of URLs and is recognized across modules", () => {
  const error = new FontsMissingError([OTHER_URL, CSS_URL, OTHER_URL]);
  assert.equal(error.code, "FONTS_MISSING");
  assert.deepEqual(error.urls, [OTHER_URL, CSS_URL].sort());
  assert.equal(isFontsMissing(error), true);
  assert.equal(isFontsMissing(new Error("FONTS_MISSING")), false);
  assert.equal(new FontsMissingError(Array.from({length: 300}, (_, index) => `${CSS_URL}${index}`)).urls.length, 256);
});
