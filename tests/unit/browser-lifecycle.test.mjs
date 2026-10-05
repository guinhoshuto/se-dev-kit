import assert from "node:assert/strict";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as sleep} from "node:timers/promises";
import test from "node:test";

import {closeStudioBrowser, launchStudioBrowser, REPRODUCIBLE_RASTER_ARGS} from "../../dist/capture/browser.js";

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("a browser that never starts fails the launch with BROWSER_LAUNCH_TIMEOUT and is killed", {timeout: 30_000, skip: process.platform === "win32"}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "sws-launch-timeout-"));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const pidFile = join(directory, "pid");
  // Stands in for a Chrome that hangs at start: it never answers on the DevTools pipe and ignores
  // SIGTERM, so Playwright's own timeout waits for an exit that never comes. The shell keeps its
  // command line, and with it the launch marker, as Chrome does.
  const fake = join(directory, "fake-chrome");
  await writeFile(fake, `#!/bin/sh\ntrap '' TERM\necho $$ > '${pidFile}'\nwhile :; do sleep 1; done\n`, {mode: 0o755});
  const started = Date.now();
  await assert.rejects(launchStudioBrowser({browserPath: fake, launchTimeoutMs: 1_000}), (error) => {
    assert.equal(error.code, "BROWSER_LAUNCH_TIMEOUT");
    assert.match(error.message, /did not start within 1 s/);
    return true;
  });
  assert.ok(Date.now() - started < 10_000, `the launch failed after ${Date.now() - started} ms`);
  const pid = Number(await readFile(pidFile, "utf8"));
  assert.ok(Number.isSafeInteger(pid) && pid > 1, `the fake browser wrote its PID (${pid})`);
  for (let attempt = 0; attempt < 50 && alive(pid); attempt += 1) await sleep(100);
  assert.equal(alive(pid), false, "the hung browser process was killed");
});

test("every launched browser gets the switches for a reproducible raster", {timeout: 30_000, skip: process.platform === "win32"}, async (t) => {
  assert.deepEqual(REPRODUCIBLE_RASTER_ARGS, ["--disable-gpu"]);
  const directory = await mkdtemp(join(tmpdir(), "sws-launch-args-"));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const argsFile = join(directory, "args");
  // Writes its arguments one per line, then exits: the launch fails, but the command line is on disk.
  const fake = join(directory, "fake-chrome");
  await writeFile(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\n`, {mode: 0o755});
  for (const headed of [false, true]) {
    await assert.rejects(launchStudioBrowser({browserPath: fake, headed, launchTimeoutMs: 5_000}));
    const args = (await readFile(argsFile, "utf8")).split("\n");
    assert.ok(args.includes("--disable-gpu"), `headed: ${headed}, args: ${args.join(" ")}`);
  }
});

test("a close that never returns gives up at its deadline; a close that fails still counts as closed", async () => {
  const hung = {close: () => new Promise(() => {})};
  const started = Date.now();
  const result = await closeStudioBrowser(hung, {timeoutMs: 300});
  assert.equal(result.closed, false);
  assert.deepEqual(result.killed, [], "a browser without a launch marker has no process to kill");
  assert.ok(Date.now() - started >= 300 && Date.now() - started < 5_000, `gave up after ${Date.now() - started} ms`);
  assert.equal((await closeStudioBrowser({close: async () => {}}, {timeoutMs: 300})).closed, true);
  assert.equal((await closeStudioBrowser({close: async () => { throw new Error("Target closed"); }}, {timeoutMs: 300})).closed, true);
});
