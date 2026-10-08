import assert from "node:assert/strict";
import {fileURLToPath} from "node:url";
import test from "node:test";

import {closeStudioBrowser, createIsolatedContext, detectBrowser, launchStudioBrowser} from "../../dist/capture/browser.js";
import {loadProject} from "../../dist/config/load.js";
import {startStudioServer} from "../../dist/server/server.js";

const exampleRoot = fileURLToPath(new URL("../../examples/basic-chat/", import.meta.url));

async function getJson(url) {
  const response = await fetch(url);
  return {status: response.status, body: await response.json()};
}

test("the dev server lists tutorial recipes and serves a variant's preview payload with one frame document per field change", async () => {
  const project = await loadProject({inputDirectory: exampleRoot});
  const server = await startStudioServer(project, {port: 0, watch: false});
  try {
    const index = await getJson(`${server.origin}/__sws/api/tutorial-preview`);
    assert.equal(index.status, 200);
    assert.deepEqual(index.body.recipes.map((recipe) => recipe.id), ["listing-tutorial", "tutorial-setup"], "only recipes with a tutorial video");

    const {status, body} = await getJson(`${server.origin}/__sws/api/tutorial-preview?recipe=tutorial-setup`);
    assert.equal(status, 200);
    assert.equal(body.variant, body.variants[0], "the first variant without ?variant");
    assert.equal(body.durationMs, 31_500);
    assert.equal(body.fieldUpdate, "reload");
    assert.equal(body.setup.timeline.endMs > 0, true);
    assert.deepEqual(body.events.map((event) => event.atMs), [...body.events.map((event) => event.atMs)].sort((left, right) => left - right), "events in time order");
    const fields = body.events.filter((event) => event.kind === "fields");
    assert.ok(fields.length > 1 && body.events.some((event) => event.kind === "dispatch"));
    // Each field change carries every value so far and its own frame document, as a render's reload does.
    assert.equal(new Set([body.load.docKey, ...fields.map((event) => event.docKey)]).size, fields.length + 1);
    const last = fields.at(-1);
    for (const event of fields) for (const [key, value] of Object.entries(event.patch)) {
      if (!fields.slice(fields.indexOf(event) + 1).some((later) => key in later.patch)) assert.deepEqual(last.fieldData[key], value);
    }
    const frameUrl = (docKey) => `${server.frameOrigin}/__sws/frame/${"a".repeat(24)}?nonce=${"b".repeat(32)}&doc=${docKey}`;
    assert.equal((await fetch(frameUrl(fields[0].docKey))).status, 200, "the field change's frame document is registered");
    assert.equal((await fetch(frameUrl("0".repeat(32)))).status, 404, "an unknown document is not served");

    const missing = await getJson(`${server.origin}/__sws/api/tutorial-preview?recipe=listing-media`);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, "TUTORIAL_PREVIEW_NOT_FOUND");
    const variant = await getJson(`${server.origin}/__sws/api/tutorial-preview?recipe=tutorial-setup&variant=nope`);
    assert.equal(variant.status, 404);

    // The preview may frame the tutorial host of its own origin; every other page keeps the frame origin only.
    const page = await fetch(`${server.origin}/__sws/tutorial-preview`);
    assert.match(page.headers.get("content-security-policy"), new RegExp(`frame-src 'self' ${server.frameOrigin};`));
    const host = await fetch(`${server.origin}/__sws/tutorial`);
    assert.match(host.headers.get("content-security-policy"), new RegExp(`frame-src ${server.frameOrigin};`));
    assert.equal((await fetch(`${server.origin}/__sws/ui/tutorial-preview.js`)).status, 200);
  } finally {
    await server.close();
  }
});

test("the tutorial preview draws the host at the scrubbed time and replays the widget's field changes on a seek back", {timeout: 120_000}, async (t) => {
  const detection = await detectBrowser();
  if (!detection.executablePath) {
    t.skip("No compatible local Chromium executable is installed; the Studio must not download one implicitly.");
    return;
  }
  const project = await loadProject({inputDirectory: exampleRoot});
  const server = await startStudioServer(project, {port: 0, watch: false});
  const {browser} = await launchStudioBrowser({browserPath: detection.executablePath});
  try {
    const context = await createIsolatedContext({browser, allowedOrigins: [server.origin, server.frameOrigin], viewport: {width: 1280, height: 800}});
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${server.origin}/__sws/tutorial-preview?recipe=tutorial-setup`);
    await page.waitForSelector("body[data-ready=true]", {timeout: 60_000});
    assert.match(await page.locator("#status").textContent(), /^tutorial-setup · .* · 31500 ms at 30 fps · script ends at \d+ ms$/);
    assert.ok(await page.locator("#camera-ticks i").count() > 0, "camera keys are marked on the track");

    const {body} = await getJson(`${server.origin}/__sws/api/tutorial-preview?recipe=tutorial-setup`);
    const rename = body.events.find((event) => event.kind === "fields" && "cardTitle" in event.patch);
    const title = () => page.frames().find((frame) => frame.url().startsWith(`${server.frameOrigin}/__sws/frame/`)).locator("#card-title").textContent();
    const seek = async (timeMs) => {
      await page.locator("#scrubber").evaluate((input, value) => {
        input.value = String(value);
        input.dispatchEvent(new Event("input"));
      }, timeMs);
      await page.waitForFunction((value) => document.querySelector("#time").value.startsWith(`${value} ms`), timeMs);
    };
    // The caption the script shows at a time: the last caption patch at or before it.
    const captionAt = (timeMs) => body.setup.timeline.patches.filter((item) => "caption" in item.patch && item.atMs <= timeMs).at(-1)?.patch.caption ?? "";
    const hostCaption = () => page.frames().find((frame) => frame.url().startsWith(`${server.origin}/__sws/tutorial?`)).locator("#se-caption").textContent();
    const original = body.load.state.fieldData.cardTitle;
    assert.notEqual(original, rename.patch.cardTitle);
    assert.equal(await title(), original);

    await seek(rename.atMs + 500);
    await assertEventually(async () => assert.equal(await title(), rename.patch.cardTitle), "the field change reached the widget");
    // The transport shows the time the host drew, and its frame at the recipe's frame rate.
    assert.equal(await page.locator("#time").textContent(), `${rename.atMs + 500} ms · frame ${Math.floor(((rename.atMs + 500) * 30) / 1000)} of 945`);
    assert.ok(captionAt(rename.atMs + 500), "the script shows a caption here");
    assert.equal(await hostCaption(), captionAt(rename.atMs + 500), "the host drew the scrubbed time");

    await seek(0);
    await assertEventually(async () => assert.equal(await title(), original), "a seek back reloads the widget with the scene's values");
    assert.equal(await hostCaption(), captionAt(0));
    assert.notEqual(captionAt(0), captionAt(rename.atMs + 500));
    assert.deepEqual(errors, []);
    await context.close();
  } finally {
    await closeStudioBrowser(browser);
    await server.close();
  }
});

async function assertEventually(check, message, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await check();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw new assert.AssertionError({message: `${message}: ${error.message}`});
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}
