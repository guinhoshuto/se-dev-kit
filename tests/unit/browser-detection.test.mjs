import assert from "node:assert/strict";
import test from "node:test";

import {detectBrowser} from "../../dist/capture/browser.js";

test("an explicit browser path is authoritative and never falls back silently", async () => {
  const requested = "/definitely-not-installed/se-widget-studio-browser";
  const detection = await detectBrowser(requested);

  assert.equal(detection.executablePath, undefined);
  assert.deepEqual(detection.checked, [requested]);
});
