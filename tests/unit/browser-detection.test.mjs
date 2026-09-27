import assert from "node:assert/strict";
import test from "node:test";

import {detectBrowser} from "../../dist/capture/browser.js";

test("an explicit browser path is authoritative and never falls back silently", async () => {
  const requested = "/definitely-not-installed/se-widget-studio-browser";
  const detection = await detectBrowser(requested);

  assert.equal(detection.executablePath, undefined);
  assert.deepEqual(detection.checked, [requested]);
});

test("the system Chrome is tried before Playwright's Chromium, which cannot play H.264", async () => {
  const {chromium} = await import("playwright-core");
  const saved = process.env.SE_WIDGET_STUDIO_BROWSER;
  delete process.env.SE_WIDGET_STUDIO_BROWSER;
  try {
    const detection = await detectBrowser();
    const cache = detection.checked.indexOf(chromium.executablePath());
    const firstSystem = detection.checked.findIndex(path => path !== chromium.executablePath());
    assert.notEqual(firstSystem, -1);
    if (cache !== -1) assert.ok(firstSystem < cache, detection.checked.join(" | "));
  } finally {
    if (saved !== undefined) process.env.SE_WIDGET_STUDIO_BROWSER = saved;
  }
});
