import assert from "node:assert/strict";
import {mkdtemp, mkdir, rm, writeFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

import {createIsolatedContext, detectBrowser, launchStudioBrowser} from "../../dist/capture/browser.js";
import {loadProject} from "../../dist/config/load.js";
import {captureHostDispatch, frameEvents, openScene} from "../../dist/scenarios/runner.js";
import {createDefaultScene} from "../../dist/scenarios/state.js";
import {startStudioServer} from "../../dist/server/server.js";

const exampleRoot = fileURLToPath(new URL("../../examples/basic-chat/", import.meta.url));

async function within(promise, label, timeoutMs = 10_000) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

test("the example dispatches onWidgetLoad and a synthetic message through the isolated runtime", {timeout: 35_000}, async (t) => {
  const detection = await detectBrowser();
  if (!detection.executablePath) {
    t.skip("No compatible local Chromium executable is installed; the Studio must not download one implicitly.");
    return;
  }

  const project = await loadProject({inputDirectory: exampleRoot});
  const scene = project.scenes.find(({id}) => id === "hero")?.value;
  assert.ok(scene, "the example hero scene must exist");

  let server;
  let browser;
  let opened;
  const diagnostics = [];
  try {
    server = await within(startStudioServer(project, {port: 0, watch: false}), "starting the Studio server", 5_000);
    ({browser} = await within(
      launchStudioBrowser({browserPath: detection.executablePath}),
      "launching the detected browser",
      10_000
    ));
    const createContext = browser.newContext.bind(browser);
    browser.newContext = async (...arguments_) => {
      const context = await createContext(...arguments_);
      context.on("page", (page) => {
        page.on("response", (response) => diagnostics.push(`response ${response.status()} ${response.url()}`));
        page.on("requestfailed", (request) =>
          diagnostics.push(`requestfailed ${request.url()} ${request.failure()?.errorText ?? "unknown"}`)
        );
        page.on("console", (message) => diagnostics.push(`console.${message.type()} ${message.text()}`));
        page.on("pageerror", (error) => diagnostics.push(`pageerror ${error.message}`));
      });
      return context;
    };
    try {
      opened = await within(openScene(project, server, browser, scene), "opening the example scene", 12_000);
    } catch (error) {
      throw new Error(`${error.message}\nBrowser diagnostics:\n${diagnostics.join("\n") || "(none)"}`, {cause: error});
    }

    const frame = opened.frame();
    await frame.locator('#chat-widget[data-loaded="true"]').waitFor({state: "visible"});
    assert.equal(await frame.locator("#card-title").textContent(), "Midnight Lounge");
    assert.equal(await frame.locator("#channel-name").textContent(), "@studio_channel");

    const lifecycleEvents = await frameEvents(opened.page);
    assert.ok(lifecycleEvents.some(({type}) => type === "frame:widget-load-dispatched"));
    assert.ok(lifecycleEvents.some(({type}) => type === "frame:assets-ready"));
    assert.ok(lifecycleEvents.some(({type}) => type === "frame:widget-ready"));

    await captureHostDispatch(opened.page, "message", {
      data: {
        messageId: "integration-message",
        displayName: "Integration Bot",
        role: "moderator",
        timestamp: "test",
        text: "Synthetic browser message arrived."
      }
    });
    const message = frame.locator('[data-message-id="integration-message"] .message-bubble');
    await message.waitFor({state: "visible"});
    assert.equal(await message.textContent(), "Synthetic browser message arrived.");

    const api = await frame.evaluate(async () => {
      await window.SE_API.store.set("qatest", {ready: true});
      const stored = await window.SE_API.store.get("qatest");
      const counter = await window.SE_API.counters.get("synthetic");
      const overlay = await window.SE_API.getOverlayStatus();
      let unsupportedCode = null;
      try {
        await window.SE_API.store.delete("qatest");
      } catch (error) {
        unsupportedCode = error?.code ?? null;
      }
      return {stored, counter, overlay, unsupportedCode};
    });
    assert.deepEqual(api, {
      stored: {ready: true},
      counter: {id: "synthetic", count: 0},
      overlay: {isEditorMode: true, muted: false},
      unsupportedCode: "SWS_UNSUPPORTED_API"
    });

    const runtimeErrors = (await frameEvents(opened.page)).filter(
      ({type}) => type === "frame:error" || type === "frame:unhandled-rejection"
    );
    assert.deepEqual(runtimeErrors, []);
    assert.deepEqual(opened.issues.errors, []);
  } finally {
    if (opened) await within(opened.context.close(), "closing the browser context", 5_000);
    if (browser) await within(browser.close(), "closing the browser", 5_000);
    if (server) await within(server.close(), "closing the Studio server", 5_000);
  }
});

test("timer-based readiness advances in fixed quanta and unmanaged previews keep the fixed Date", {timeout: 45_000}, async (t) => {
  const detection = await detectBrowser();
  if (!detection.executablePath) {
    t.skip("No compatible local Chromium executable is installed; the Studio must not download one implicitly.");
    return;
  }

  const root = await mkdtemp(join(tmpdir(), "sws-clock-integration-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(join(root, "scenes"));
  await Promise.all([
    writeFile(join(root, "widget.html"), '<main id="widget">Clock fixture</main>\n'),
    writeFile(join(root, "widget.css"), "#widget { color: white; }\n"),
    writeFile(join(root, "widget.json"), '{}\n'),
    writeFile(
      join(root, "widget.js"),
      `window.addEventListener("onWidgetLoad", () => {
  const startedAt = performance.now();
  const fixedDate = Date.now();
  setTimeout(() => {
    const ready = document.createElement("div");
    ready.id = "timer-ready";
    ready.dataset.elapsed = String(Math.round(performance.now() - startedAt));
    ready.dataset.date = String(fixedDate);
    document.body.append(ready);
  }, 96);
});\n`
    ),
    writeFile(
      join(root, "se-widget-studio.config.mjs"),
      `export default {
  schemaVersion: 1,
  widget: {
    root: ".",
    viewport: {width: 320, height: 240, deviceScaleFactor: 1},
    ready: {selector: "#timer-ready", timeoutMs: 1000}
  },
  scenes: {glob: "scenes/*.json"},
  output: {root: ".se-widget-studio/output"}
};\n`
    )
  ]);

  const project = await loadProject({inputDirectory: root});
  const scene = createDefaultScene(project);
  const server = await startStudioServer(project, {port: 0, watch: false});
  const {browser} = await launchStudioBrowser({browserPath: detection.executablePath});
  try {
    const elapsed = [];
    for (let run = 0; run < 3; run += 1) {
      const opened = await openScene(project, server, browser, scene);
      try {
        const ready = opened.frame().locator("#timer-ready");
        elapsed.push(await ready.getAttribute("data-elapsed"));
        assert.equal(await ready.getAttribute("data-date"), String(Date.parse("2025-01-15T12:00:00.000Z")));
      } finally {
        await opened.context.close();
      }
    }
    assert.deepEqual(elapsed, ["96", "96", "96"]);

    const context = await createIsolatedContext({
      browser,
      allowedOrigins: [server.origin, server.frameOrigin],
      viewport: {width: 1280, height: 800}
    });
    try {
      const page = await context.newPage();
      await page.goto(server.origin, {waitUntil: "domcontentloaded"});
      const iframe = page.locator("#widget-frame");
      await iframe.waitFor({state: "attached"});
      const frame = await (await iframe.elementHandle()).contentFrame();
      assert.ok(frame);
      await frame.locator("#timer-ready").waitFor({state: "attached"});
      assert.equal(await frame.evaluate(() => Date.now()), Date.parse("2025-01-15T12:00:00.000Z"));
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
});
