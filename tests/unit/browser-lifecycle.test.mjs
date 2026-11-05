import assert from "node:assert/strict";
import {mkdtemp, readdir, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as sleep} from "node:timers/promises";
import test from "node:test";

import {closeStudioBrowser, LAUNCH_TIMEOUT_MS, launchStudioBrowser, REPRODUCIBLE_RASTER_ARGS} from "../../dist/capture/browser.js";

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
  await assert.rejects(launchStudioBrowser({browserPath: fake, launchTimeoutMs: 1_000, launchRetries: 0}), (error) => {
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

// Answers Playwright on the DevTools pipe (fds 3 and 4) as much as a launch and a close need, so a launch can succeed without a Chrome.
const PIPE_CHROME = `
import {createReadStream, createWriteStream} from "node:fs";
const output = createWriteStream(null, {fd: 4});
let buffer = "";
createReadStream(null, {fd: 3}).on("data", (chunk) => {
  buffer += chunk;
  for (let end; (end = buffer.indexOf("\\0")) >= 0; buffer = buffer.slice(end + 1)) {
    const {id, method} = JSON.parse(buffer.slice(0, end));
    const result = method === "Browser.getVersion" ? {product: "Chrome/1.0.0.0", revision: "1", userAgent: "fake", jsVersion: "1", protocolVersion: "1.3"} : {};
    if (method === "Browser.close") process.exit(0);
    output.write(JSON.stringify({id, result}) + "\\0");
  }
});
`;

/** A browser that hangs on its first `hung` starts and then works, and the file where each start writes its PID. */
async function flakyBrowser(t, hung) {
  const directory = await mkdtemp(join(tmpdir(), "sws-launch-retry-"));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const starts = join(directory, "starts");
  await writeFile(join(directory, "pipe-chrome.mjs"), PIPE_CHROME);
  const fake = join(directory, "fake-chrome");
  await writeFile(fake, `#!/bin/sh\necho $$ >> '${starts}'\nif [ "$(wc -l < '${starts}')" -le ${hung} ]; then\n  while :; do sleep 1; done\nfi\nexec '${process.execPath}' '${join(directory, "pipe-chrome.mjs")}'\n`, {mode: 0o755});
  return {fake, startedPids: async () => (await readFile(starts, "utf8")).trim().split("\n").map(Number)};
}

test("a launch that runs out of time starts Chrome once more, says why, and that browser works", {timeout: 60_000, skip: process.platform === "win32"}, async (t) => {
  const {fake, startedPids} = await flakyBrowser(t, 1);
  const said = [];
  const {browser} = await launchStudioBrowser({browserPath: fake, launchTimeoutMs: 5_000, onLaunchRetry: (line) => said.push(line)});
  t.after(() => closeStudioBrowser(browser));
  assert.equal(browser.isConnected(), true);
  const pids = await startedPids();
  assert.equal(pids.length, 2, "one start that hung and the one that answered");
  assert.equal(said.length, 1);
  assert.match(said[0], /^Chrome launch retried: Chrome did not start within 5 s \(.*fake-chrome\)\. That process was killed and Chrome starts once more; load \d+\.\d on \d+ cores\.$/);
  for (let attempt = 0; attempt < 50 && alive(pids[0]); attempt += 1) await sleep(100);
  assert.equal(alive(pids[0]), false, "the start that hung was killed");
});

test("a launch fails with BROWSER_LAUNCH_TIMEOUT only when the second start runs out of time too, and no third one comes", {timeout: 60_000, skip: process.platform === "win32"}, async (t) => {
  const {fake, startedPids} = await flakyBrowser(t, 99);
  const said = [];
  await assert.rejects(launchStudioBrowser({browserPath: fake, launchTimeoutMs: 1_000, onLaunchRetry: (line) => said.push(line)}), (error) => {
    assert.equal(error.code, "BROWSER_LAUNCH_TIMEOUT");
    return true;
  });
  const pids = await startedPids();
  assert.equal(pids.length, 2);
  assert.equal(said.length, 1);
  for (const pid of pids) {
    for (let attempt = 0; attempt < 50 && alive(pid); attempt += 1) await sleep(100);
    assert.equal(alive(pid), false, `start ${pid} was killed`);
  }
});

test("a launch that fails for any other reason is not started again", {timeout: 30_000, skip: process.platform === "win32"}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "sws-launch-exits-"));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const starts = join(directory, "starts");
  const fake = join(directory, "fake-chrome");
  await writeFile(fake, `#!/bin/sh\necho $$ >> '${starts}'\nexit 1\n`, {mode: 0o755});
  const said = [];
  await assert.rejects(launchStudioBrowser({browserPath: fake, launchTimeoutMs: 5_000, onLaunchRetry: (line) => said.push(line)}), (error) => {
    assert.notEqual(error.code, "BROWSER_LAUNCH_TIMEOUT");
    return true;
  });
  assert.equal((await readFile(starts, "utf8")).trim().split("\n").length, 1);
  assert.deepEqual(said, []);
});

// A test's own timeout below two launches and their grace leaves the retry no time to work. `npm test` had a first run
// fail on one launch on 2026-11-04 (#33); a test's own bound shorter than this would still fail it, with another message.
test("a test that starts Chrome in its body leaves room for a retried launch", async () => {
  const room = 2 * (LAUNCH_TIMEOUT_MS + 5_000) + 30_000;
  const checked = [];
  for (const folder of ["../integration/", "../web/"]) {
    const directory = new URL(folder, import.meta.url);
    for (const file of (await readdir(directory)).filter((name) => /\.test\.(mjs|ts)$/.test(name))) {
      for (const block of (await readFile(new URL(file, directory), "utf8")).split(/^(?=test\()/m).slice(1)) {
        if (!/launchStudioBrowser\(|renderRecipe\(/.test(block)) continue;
        const own = /\{[^{}]*\btimeout: ([\d_]+)/.exec(block.split("\n")[0]);
        checked.push(file);
        if (own) assert.ok(Number(own[1].replaceAll("_", "")) >= room, `${file}: ${block.split("\n")[0].slice(0, 120)} has less than ${room} ms`);
      }
    }
  }
  assert.ok(checked.length >= 10, `found ${checked.length} tests; the split no longer finds them`);
});

test("every launched browser gets the switches for a reproducible raster", {timeout: 30_000, skip: process.platform === "win32"}, async (t) => {
  assert.deepEqual(REPRODUCIBLE_RASTER_ARGS, ["--disable-gpu", "--disable-threaded-animation"]);
  const directory = await mkdtemp(join(tmpdir(), "sws-launch-args-"));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const argsFile = join(directory, "args");
  // Writes its arguments one per line, then exits: the launch fails, but the command line is on disk.
  const fake = join(directory, "fake-chrome");
  await writeFile(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\n`, {mode: 0o755});
  for (const headed of [false, true]) {
    await assert.rejects(launchStudioBrowser({browserPath: fake, headed, launchTimeoutMs: 5_000}));
    const args = (await readFile(argsFile, "utf8")).split("\n");
    for (const expected of REPRODUCIBLE_RASTER_ARGS) assert.ok(args.includes(expected), `${expected}, headed: ${headed}, args: ${args.join(" ")}`);
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
