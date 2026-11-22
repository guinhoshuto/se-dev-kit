// Starts a browser that never answers through the real launch, so the launch and its retry both run out of time, until
// the file SWS_FAKE_LAUNCH_STARTS names exists: then the machine is free and Chrome starts, which this fake stands for by
// passing without a launch. What the reporter prints for the timeout is what a browser suite's log gets.
import {existsSync} from "node:fs";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

import {launchStudioBrowser} from "../../../dist/capture/browser.js";

test("a launch that times out while the machine is busy", async (t) => {
  if (existsSync(process.env.SWS_FAKE_LAUNCH_STARTS ?? "")) return;
  const directory = await mkdtemp(join(tmpdir(), "launch-timeout-"));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const fake = join(directory, "fake-chrome");
  await writeFile(fake, "#!/bin/sh\nwhile :; do sleep 1; done\n", {mode: 0o755});
  await launchStudioBrowser({browserPath: fake, launchTimeoutMs: 300});
});
