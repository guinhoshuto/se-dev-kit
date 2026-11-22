import assert from "node:assert/strict";
import {lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {basename, dirname, isAbsolute, join, relative} from "node:path";
import {setTimeout as sleep} from "node:timers/promises";
import test from "node:test";

import {CLEANUP_TIMEOUT_MS, closeStudioBrowser, closeTimeoutDetail, launchFolders, LAUNCH_TIMEOUT_MS, launchStudioBrowser, removeLaunchFolders, REPRODUCIBLE_RASTER_ARGS} from "../../dist/capture/browser.js";

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
    // The hung shell is still alive at the kill: its command line, found by ps, names the profile.
    assert.match(error.hint, /; Playwright's launch finished after \d+ ms; (?:already gone|removed) playwright_chromiumdev_profile-\S+\.$/);
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
  const room = 2 * (LAUNCH_TIMEOUT_MS + 5_000 + CLEANUP_TIMEOUT_MS) + 30_000;
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

// #52: a close or a launch that ran out of time left Playwright's folders in TMPDIR when the render's process exited
// before Playwright's own asynchronous removal ended. These tests point Playwright at a TMPDIR of their own.

/** A fresh folder that Playwright makes the folders of the launches inside `launch` in; TMPDIR is restored after it. */
async function playwrightTemporary(t, name) {
  const directory = await mkdtemp(join(tmpdir(), `sws-${name}-`));
  t.after(() => rm(directory, {recursive: true, force: true}));
  // Another browser's folders, which no cleanup of this one may touch.
  const foreign = ["playwright_chromiumdev_profile-foreign", "playwright-artifacts-foreign"];
  for (const name of foreign) {
    await mkdir(join(directory, name));
    await writeFile(join(directory, name, "Local State"), "{}");
  }
  const within = async (launch) => {
    const before = process.env.TMPDIR;
    process.env.TMPDIR = directory;
    try {
      return await launch();
    } finally {
      if (before === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = before;
    }
  };
  return {directory, foreign, within, own: async () => (await readdir(directory)).filter((name) => !foreign.includes(name)).sort()};
}

// Keeps the launching process's stderr open from a session of its own, as a Chrome helper that outlives the kill of the
// browser's process group may: Playwright removes the folders only once stderr closes. It ends itself after 2 minutes.
const STDERR_HOLDER = `
import {spawn} from "node:child_process";
import {writeFileSync} from "node:fs";
const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120_000)"], {detached: true, stdio: ["ignore", "ignore", "inherit"]});
writeFileSync(process.argv[2], String(child.pid));
child.unref();
`;

/**
 * A folder for a fake browser and the shell line that starts a stderr holder from it. When the test ends, one hook
 * kills the holder, if it started, and only then removes the folder that names its PID.
 */
async function holderDirectory(t, prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const pidFile = join(directory, "holder.pid");
  t.after(async () => {
    try {
      process.kill(Number(await readFile(pidFile, "utf8")), "SIGKILL");
    } catch {
      // Never started, or already gone.
    }
    await rm(directory, {recursive: true, force: true});
  });
  await writeFile(join(directory, "holder.mjs"), STDERR_HOLDER);
  return {directory, holder: `'${process.execPath}' '${join(directory, "holder.mjs")}' '${pidFile}'`};
}

/** A browser that launches but never answers Browser.close; with `held`, a helper keeps its stderr open past a kill. */
async function unclosableBrowser(t, {held}) {
  const {directory, holder} = await holderDirectory(t, "sws-close-held-");
  await writeFile(join(directory, "pipe-chrome.mjs"), PIPE_CHROME.replace('if (method === "Browser.close") process.exit(0);', 'if (method === "Browser.close") return;'));
  const fake = join(directory, "fake-chrome");
  // "$@" keeps the launch marker on the command line, as Chrome's own, so the close finds the process to kill.
  await writeFile(fake, `#!/bin/sh\n${held ? holder : ""}\nexec '${process.execPath}' '${join(directory, "pipe-chrome.mjs")}' "$@"\n`, {mode: 0o755});
  return fake;
}

test("a launched browser's artifacts folder and profile are found right after the launch, and a close in time does no cleanup of its own", {timeout: 30_000, skip: process.platform === "win32"}, async (t) => {
  assert.equal(CLEANUP_TIMEOUT_MS, 5_000);
  const temporary = await playwrightTemporary(t, "launch-folders");
  const {fake} = await flakyBrowser(t, 0);
  const {browser} = await temporary.within(() => launchStudioBrowser({browserPath: fake, launchTimeoutMs: 10_000, launchRetries: 0}));
  const found = launchFolders(browser);
  assert.equal(found?.temporary, temporary.directory);
  assert.deepEqual(found.folders.map((folder) => basename(folder).replace(/-[^-]+$/, "-")), ["playwright-artifacts-", "playwright_chromiumdev_profile-"], `Playwright's server object no longer names them: ${JSON.stringify(found)}`);
  for (const folder of found.folders) {
    assert.equal(dirname(folder), temporary.directory);
    assert.equal((await lstat(folder)).isDirectory(), true, `${folder} exists`);
  }
  assert.deepEqual(found.folders.map((folder) => basename(folder)).sort(), await temporary.own());
  const result = await closeStudioBrowser(browser);
  assert.deepEqual([result.closed, result.killed, result.cleanup], [true, [], undefined]);
  assert.deepEqual(await temporary.own(), [], "Playwright's own close removed them");
});

test("a launch under a relative TMPDIR records its temporary folder and its folders as absolute paths", {timeout: 30_000, skip: process.platform === "win32"}, async (t) => {
  const temporary = await playwrightTemporary(t, "launch-relative");
  const {fake} = await flakyBrowser(t, 0);
  const relativeTemporary = relative(process.cwd(), temporary.directory);
  assert.equal(isAbsolute(relativeTemporary), false);
  const before = process.env.TMPDIR;
  process.env.TMPDIR = relativeTemporary;
  let launched;
  try {
    launched = await launchStudioBrowser({browserPath: fake, launchTimeoutMs: 10_000, launchRetries: 0});
  } finally {
    if (before === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = before;
  }
  t.after(() => closeStudioBrowser(launched.browser));
  // A close from another working directory still removes these, not namesakes under it.
  const found = launchFolders(launched.browser);
  assert.equal(found?.temporary, temporary.directory);
  assert.equal(found.folders.length, 2, JSON.stringify(found));
  for (const folder of found.folders) assert.equal(dirname(folder), temporary.directory, `${folder} is absolute`);
  assert.equal((await closeStudioBrowser(launched.browser)).closed, true);
});

test("a close that runs out of time removes its browser's folders when Playwright's cleanup does not, and leaves another browser's", {timeout: 30_000, skip: process.platform === "win32"}, async (t) => {
  const temporary = await playwrightTemporary(t, "close-cleanup");
  const fake = await unclosableBrowser(t, {held: true});
  const {browser} = await temporary.within(() => launchStudioBrowser({browserPath: fake, launchTimeoutMs: 10_000, launchRetries: 0}));
  const own = await temporary.own();
  assert.equal(own.length, 2, own.join(", "));
  const started = Date.now();
  const result = await closeStudioBrowser(browser, {timeoutMs: 300, cleanupTimeoutMs: 500});
  assert.ok(Date.now() - started < 5_000, `the close gave up after ${Date.now() - started} ms`);
  assert.equal(result.closed, false);
  assert.equal(result.killed.length, 1, "the browser found by its marker");
  assert.equal(result.cleanup.settled, false, "Playwright's close still waits for the helper holding stderr");
  assert.ok(result.cleanup.waitedMs >= 500, `waited ${result.cleanup.waitedMs} ms`);
  assert.deepEqual([[...result.cleanup.removed].sort(), result.cleanup.gone, result.cleanup.failed, result.cleanup.skipped], [own, [], [], []]);
  assert.deepEqual(await temporary.own(), [], "no folder of this browser is left");
  assert.deepEqual((await readdir(temporary.directory)).sort(), [...temporary.foreign].sort(), "another browser's folders survive");
  assert.match(closeTimeoutDetail(result), /^killed PID \d+ after \d+ ms; Playwright's close still pending after \d+ ms; removed playwright-artifacts-\S+, playwright_chromiumdev_profile-\S+$/);
});

test("a close that runs out of time waits for Playwright's own cleanup and says it finished", {timeout: 30_000, skip: process.platform === "win32"}, async (t) => {
  const temporary = await playwrightTemporary(t, "close-finished");
  const fake = await unclosableBrowser(t, {held: false});
  const {browser} = await temporary.within(() => launchStudioBrowser({browserPath: fake, launchTimeoutMs: 10_000, launchRetries: 0}));
  const own = await temporary.own();
  const result = await closeStudioBrowser(browser, {timeoutMs: 300, cleanupTimeoutMs: 10_000});
  assert.equal(result.closed, false);
  assert.equal(result.cleanup.settled, true, "the kill let Playwright's close finish");
  assert.ok(result.cleanup.waitedMs < 10_000);
  assert.deepEqual([result.cleanup.removed, [...result.cleanup.gone].sort()], [[], own], "Playwright removed them before this module looked");
  assert.deepEqual((await readdir(temporary.directory)).sort(), [...temporary.foreign].sort());
  assert.match(closeTimeoutDetail(result), /^killed PID \d+ after \d+ ms; Playwright's close finished after \d+ ms; already gone playwright-artifacts-\S+, playwright_chromiumdev_profile-\S+$/);
});

test("a launch that runs out of time removes the profile of the Chrome it killed and says so, and leaves another browser's", {timeout: 30_000, skip: process.platform === "win32"}, async (t) => {
  const temporary = await playwrightTemporary(t, "launch-cleanup");
  const {directory, holder} = await holderDirectory(t, "sws-launch-held-");
  // Hangs at start and ignores SIGTERM, keeps its stderr open past a kill, and writes into its profile as Chrome does,
  // so Playwright's removal at its own timeout does not get rid of it.
  const fake = join(directory, "fake-chrome");
  await writeFile(fake, `#!/bin/sh\ntrap '' TERM\nfor a in "$@"; do case "$a" in --user-data-dir=*) profile="\${a#--user-data-dir=}";; esac; done\n${holder}\nwhile :; do mkdir -p "$profile"; : > "$profile/Local State"; sleep 0.2; done\n`, {mode: 0o755});
  const started = Date.now();
  await assert.rejects(temporary.within(() => launchStudioBrowser({browserPath: fake, launchTimeoutMs: 1_000, launchRetries: 0, cleanupTimeoutMs: 500})), (error) => {
    assert.equal(error.code, "BROWSER_LAUNCH_TIMEOUT");
    assert.match(error.hint, /The process this launch started was killed; Playwright's launch still pending after \d+ ms; removed playwright_chromiumdev_profile-\S+\.$/);
    return true;
  });
  assert.ok(Date.now() - started < 15_000, `the launch failed after ${Date.now() - started} ms`);
  assert.deepEqual(await temporary.own(), [], "no folder of this launch is left");
  assert.deepEqual((await readdir(temporary.directory)).sort(), [...temporary.foreign].sort(), "another browser's folders survive");
});

test("a launch whose Playwright timeout comes first names its profile from the call log", {timeout: 30_000, skip: process.platform === "win32"}, async (t) => {
  const temporary = await playwrightTemporary(t, "launch-call-log");
  const directory = await mkdtemp(join(tmpdir(), "sws-launch-silent-"));
  t.after(() => rm(directory, {recursive: true, force: true}));
  // Answers nothing on the pipe and exits at Browser.close: Playwright's own timeout (1 s) comes before this module's
  // deadline, Playwright closes the process, ps finds no child, and only the error's call log names the profile.
  await writeFile(join(directory, "silent-chrome.mjs"), PIPE_CHROME.replace('output.write(JSON.stringify({id, result}) + "\\0");', ""));
  const fake = join(directory, "fake-chrome");
  await writeFile(fake, `#!/bin/sh\nexec '${process.execPath}' '${join(directory, "silent-chrome.mjs")}' "$@"\n`, {mode: 0o755});
  await assert.rejects(temporary.within(() => launchStudioBrowser({browserPath: fake, launchTimeoutMs: 1_000, launchRetries: 0})), (error) => {
    assert.equal(error.code, "BROWSER_LAUNCH_TIMEOUT");
    assert.match(error.hint, /The process this launch started was killed; Playwright's launch finished after \d+ ms; (?:already gone|removed) playwright_chromiumdev_profile-\S+\.$/);
    return true;
  });
  assert.deepEqual(await temporary.own(), [], "no folder of this launch is left");
  assert.deepEqual((await readdir(temporary.directory)).sort(), [...temporary.foreign].sort(), "another browser's folders survive");
});

test("removeLaunchFolders checks and removes one resolved path, so a link before a `..` cannot reach outside", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "sws-remove-dotdot-"));
  const outside = await mkdtemp(join(tmpdir(), "sws-remove-dotdot-outside-"));
  t.after(() => Promise.all([temporary, outside].map((folder) => rm(folder, {recursive: true, force: true}))));
  // The kernel follows `link-dir` first: `<temporary>/link-dir/../<name>` is `<outside>/<name>` on disk. `up` exists
  // only outside, so the lstat decides; `both` exists in both places, so the rm decides.
  await mkdir(join(outside, "inner"));
  const victims = ["playwright_chromiumdev_profile-up", "playwright_chromiumdev_profile-both"].map((name) => join(outside, name));
  for (const victim of victims) await mkdir(victim);
  await mkdir(join(temporary, "playwright_chromiumdev_profile-both"));
  await symlink(join(outside, "inner"), join(temporary, "link-dir"));
  const result = await removeLaunchFolders(victims.map((victim) => `${join(temporary, "link-dir")}/../${basename(victim)}`), temporary);
  assert.deepEqual(result, {removed: ["playwright_chromiumdev_profile-both"], gone: ["playwright_chromiumdev_profile-up"], failed: [], skipped: []});
  for (const victim of victims) assert.equal((await lstat(victim)).isDirectory(), true, `${victim}, outside the temporary folder, survives`);
  await assert.rejects(lstat(join(temporary, "playwright_chromiumdev_profile-both")), {code: "ENOENT"});
});

test("removeLaunchFolders removes only a Playwright folder directly in the launch's temporary folder", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "sws-remove-folders-"));
  const outside = await mkdtemp(join(tmpdir(), "sws-remove-outside-"));
  t.after(() => Promise.all([temporary, outside].map((folder) => rm(folder, {recursive: true, force: true}))));
  const own = ["playwright-artifacts-Ab12Cd", "playwright_chromiumdev_profile-Ef34Gh"].map((name) => join(temporary, name));
  const kept = [join(temporary, "nested", "playwright_chromiumdev_profile-deep"), join(temporary, "other-folder"), join(temporary, "playwright_chromiumdev_profile-"), join(outside, "playwright_chromiumdev_profile-out")];
  for (const folder of [...own, ...kept]) await mkdir(folder, {recursive: true});
  const link = join(temporary, "playwright-artifacts-link");
  await symlink(kept[3], link);
  const missing = join(temporary, "playwright-artifacts-missing");
  const result = await removeLaunchFolders([...own, ...kept, link, missing], temporary);
  assert.deepEqual(result, {removed: own.map((folder) => basename(folder)), gone: ["playwright-artifacts-missing"], failed: [], skipped: [...kept, link]});
  for (const folder of [...kept, link]) assert.ok(await lstat(folder), `${folder} is still there`);
});
