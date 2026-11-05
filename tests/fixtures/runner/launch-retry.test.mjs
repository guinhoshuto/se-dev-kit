// Starts a browser that never answers, twice, through the real launch: what it says on stderr is what a suite's log gets.
import assert from "node:assert/strict";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

import {launchStudioBrowser} from "../../../dist/capture/browser.js";

test("a launch that never answers", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "launch-retry-"));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const fake = join(directory, "fake-chrome");
  await writeFile(fake, "#!/bin/sh\nwhile :; do sleep 1; done\n", {mode: 0o755});
  await assert.rejects(launchStudioBrowser({browserPath: fake, launchTimeoutMs: 500}), {code: "BROWSER_LAUNCH_TIMEOUT"});
});
