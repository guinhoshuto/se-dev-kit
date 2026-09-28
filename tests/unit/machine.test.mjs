import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtemp, realpath, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as sleep} from "node:timers/promises";
import test from "node:test";

import {BROWSER_MARKER as ENGINE_MARKER} from "../../dist/capture/browser.js";
import {BROWSER_MARKER, browserGate, checkoutOrphans, listProcesses, otherSessionsWork, parseProcessList} from "../../scripts/lib/machine.mjs";
import {killStale} from "../../scripts/kill-stale.mjs";

const ROOT = "/work/se-dev-kit";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const cwds = new Map();
const cwd = async (pid) => cwds.get(pid);

function processes() {
  cwds.clear();
  const list = [
    {pid: 10, ppid: 1, command: `${CHROME} --headless --remote-debugging-pipe ${BROWSER_MARKER}=77-1`, cwd: ROOT},
    {pid: 11, ppid: 1, command: `${CHROME} --headless --remote-debugging-pipe ${BROWSER_MARKER}=78-1`, cwd: "/work/se-windows"},
    {pid: 12, ppid: 40, command: `${CHROME} --headless --remote-debugging-pipe ${BROWSER_MARKER}=40-1`, cwd: ROOT},
    {pid: 20, ppid: 1, command: "/opt/homebrew/bin/node --import tsx --test-force-exit /work/se-dev-kit/tests/web/jobs.test.ts", cwd: ROOT},
    {pid: 21, ppid: 20, command: `${CHROME} --headless --remote-debugging-pipe ${BROWSER_MARKER}=20-1`, cwd: ROOT},
    {pid: 22, ppid: 21, command: `${CHROME} Helper (Renderer) --type=renderer`, cwd: ROOT},
    {pid: 30, ppid: 1, command: "/opt/homebrew/bin/node --test --test-concurrency=1 tests/integration/tutorial.test.mjs", cwd: ROOT},
    {pid: 31, ppid: 1, command: "/opt/homebrew/bin/node /work/se-dev-kit/dist/cli/index.js render . --recipe listing", cwd: ROOT},
    {pid: 40, ppid: 900, command: "/opt/homebrew/bin/node /work/se-dev-kit/tests/integration/browser.test.mjs", cwd: ROOT},
    {pid: 50, ppid: 1, command: "/opt/homebrew/bin/node /work/remotion/node_modules/@remotion/cli/remotion-cli.js render", cwd: "/work/background-creator"},
    {pid: 60, ppid: 1, command: `${CHROME} --type=renderer`, cwd: "/"},
    {pid: 61, ppid: 1, command: "/opt/homebrew/bin/node /work/se-dev-kit/dist/cli/index.js dev .", cwd: ROOT}
  ];
  for (const item of list) cwds.set(item.pid, item.cwd);
  return list.map(({pid, ppid, command}) => ({pid, ppid, command}));
}

test("the kill-stale marker is the switch launchStudioBrowser puts on every Chrome", () => {
  assert.equal(BROWSER_MARKER, ENGINE_MARKER);
  assert.equal(BROWSER_MARKER, "--se-widget-studio");
});

test("ps output parses into pid, ppid and the full command", () => {
  assert.deepEqual(parseProcessList("    1     0 /sbin/launchd\n  402     1 /usr/libexec/UserEventAgent (System)\n\n"), [
    {pid: 1, ppid: 0, command: "/sbin/launchd"},
    {pid: 402, ppid: 1, command: "/usr/libexec/UserEventAgent (System)"}
  ]);
});

test("orphans are this checkout's marked Chromes and dead runners' workers with their Chrome, never a live launcher's", async () => {
  const {orphans, reported} = await checkoutOrphans(ROOT, processes(), {cwd});
  assert.deepEqual(orphans.map((item) => item.pid).sort((a, b) => a - b), [10, 20, 21]);
  // A PPID-1 runner or CLI render may be a job someone put in the background: reported, not killed.
  assert.deepEqual(reported.map((item) => item.pid).sort((a, b) => a - b), [30, 31, 61]);
});

test("another session's work is any headless or piped Chrome, Remotion or local render outside the caller's own tree", () => {
  const busy = otherSessionsWork(processes(), [900]).map((item) => item.pid).sort((a, b) => a - b);
  // 12 and 40 belong to the caller (900). A test worker (20), a runner (30), a plain renderer (60)
  // and the dev server (61) are not renders themselves.
  assert.deepEqual(busy, [10, 11, 21, 31, 50]);
});

test("the browser gate refuses below 3 GiB free, for orphans and for another session's render, and passes otherwise", async () => {
  const quiet = [{pid: 900, ppid: 1, command: "/opt/homebrew/bin/node scripts/run-tests.mjs"}];
  const gate = (options) => browserGate({root: ROOT, paths: ["/work"], ownRoots: [900], cwd, ...options});
  assert.deepEqual(await gate({processes: quiet, free: async () => 3 * 1024 ** 3}), {ok: true});
  const low = await gate({processes: quiet, free: async () => 3 * 1024 ** 3 - 1});
  assert.equal(low.ok, false);
  assert.match(low.reason, /only 2\.9 GiB free on the volume of \/work; browser suites need 3\.0 GiB/);
  const orphaned = await gate({processes: [...quiet, ...processes()], free: async () => 10 * 1024 ** 3});
  assert.match(orphaned.reason, /orphan process\(es\) \(PID 10, 20, 21\); run npm run kill-stale/);
  const busy = await gate({processes: [...quiet, processes()[1]], free: async () => 10 * 1024 ** 3});
  assert.match(busy.reason, /another session is rendering: PID 11 /);
});

test("kill-stale kills a real marked orphan of this checkout and leaves one from another folder alone", {timeout: 30_000}, async (t) => {
  const ours = await realpath(await mkdtemp(join(tmpdir(), "sws-orphan-ours-")));
  const theirs = await realpath(await mkdtemp(join(tmpdir(), "sws-orphan-theirs-")));
  const pids = [];
  t.after(async () => {
    for (const pid of pids) try { process.kill(pid, "SIGKILL"); } catch {}
    await rm(ours, {recursive: true, force: true});
    await rm(theirs, {recursive: true, force: true});
  });
  // A launcher that starts a marked, detached child and exits: the child is left with PPID 1, like a
  // Chrome whose test process was killed.
  const orphanIn = async (folder, label) => {
    const launcher = spawn(process.execPath, ["-e", `const {spawn} = require("node:child_process");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", "${BROWSER_MARKER}=${label}"], {detached: true, stdio: "ignore"});
process.stdout.write(String(child.pid)); child.unref();`], {cwd: folder, stdio: ["ignore", "pipe", "inherit"]});
    let output = "";
    launcher.stdout.on("data", (chunk) => { output += chunk; });
    await new Promise((done) => launcher.once("close", done));
    const pid = Number(output);
    pids.push(pid);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if ((await listProcesses()).find((item) => item.pid === pid)?.ppid === 1) return pid;
      await sleep(100);
    }
    assert.fail(`PID ${pid} never became an orphan`);
  };
  const ourPid = await orphanIn(ours, "orphan-test-ours");
  const theirPid = await orphanIn(theirs, "orphan-test-theirs");
  const lines = [];
  const {killed} = await killStale(ours, (line) => lines.push(line));
  assert.deepEqual(killed.map((item) => item.pid), [ourPid]);
  assert.match(lines.join("\n"), new RegExp(`Killed PID ${ourPid}: `));
  for (let attempt = 0; attempt < 50 && (await listProcesses()).some((item) => item.pid === ourPid); attempt += 1) await sleep(100);
  assert.equal((await listProcesses()).some((item) => item.pid === ourPid), false, "our orphan is gone");
  assert.equal((await listProcesses()).find((item) => item.pid === theirPid)?.ppid, 1, "the other folder's orphan still runs");
});
