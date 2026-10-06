import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {mkdtemp, realpath, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as sleep} from "node:timers/promises";
import test from "node:test";
import {fileURLToPath} from "node:url";

import {BROWSER_MARKER as ENGINE_MARKER} from "../../dist/capture/browser.js";
import {BROWSER_MARKER, browserGate, checkoutOrphans, isHeavy, listProcesses, machineVerdict, otherSessionsWork, parseProcessList, parseVerdict} from "../../scripts/lib/machine.mjs";
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

test("Remotion is another session's render only while its CLI renders or its compositor runs, never for naming the word", () => {
  // HAR-32, 2026-10-06: the bare `remotion` pattern reported a wrapper in a remotion-mock folder as a render.
  for (const command of [
    "node /x/node_modules/.bin/remotion render src/index.ts Comp out/a.mp4",
    "node /opt/homebrew/bin/npx remotion still src/index.ts RegistroDemo out/f30.png --frame=30",
    // The same npx once npm sets its process title: ps shows this, padded with the spaces left over.
    "npm exec remotion still src/index.ts RegistroDemo out/f30.png --frame=30    ",
    "/opt/homebrew/bin/node /x/node_modules/@remotion/cli/remotion-cli.js benchmark src/index.ts",
    '/x/node_modules/@remotion/compositor-darwin-arm64/remotion {"type":"x"}'
  ]) assert.equal(isHeavy(command), true, command);
  for (const command of [
    "node .cache/remotion-mock/slot-run.mts .cache/remotion-mock/all.sh",
    "tail -f /x/remotion-mock/progress.log",
    "vim remotion.config.ts",
    "node /x/node_modules/.bin/remotion studio",
    "node /x/node_modules/.bin/remotion compositions src/index.ts",
    "npm exec remotion bundle src/index.ts"
  ]) assert.equal(isHeavy(command), false, command);
});

test("Blender is another session's render only when its executable runs in the background (-b or --background)", () => {
  // HAR-32: a 511 s Blender render in a Codex session went unseen by the machine check.
  for (const command of [
    "/Applications/Blender.app/Contents/MacOS/Blender -b scene.blend -a",
    "/x/.cache/birthday-balloons/runtime/Blender.app/Contents/MacOS/Blender --background --factory-startup --python scripts/blender/birthday_balloons.py -- --output-dir out/review/2026-10-06-birthday-balloons",
    "blender -b scene.blend -f 1"
  ]) assert.equal(isHeavy(command), true, command);
  for (const command of [
    "/Applications/Blender.app/Contents/MacOS/Blender",
    "/Applications/Blender.app/Contents/MacOS/Blender scene.blend",
    // The Quick Look thumbnailer that ships inside Blender.app.
    "/Volumes/Sandisk/Applications/Blender.app/Contents/PlugIns/blender-thumbnailer.appex/Contents/MacOS/blender-thumbnailer -BSServiceDomains {}",
    // A command that only names it, like a request to an agent.
    "claude -p render it with blender -b scene.blend -a"
  ]) assert.equal(isHeavy(command), false, command);
});

test("the caller's ancestors, and a shell or pgrep that only mentions a pattern, are not another session's render", () => {
  // The check names a heavy pattern (Chrome.*--headless), so only the wrapper rule keeps 700 and 710 out.
  const check = "pgrep -fl 'Chrome.*--headless|remotion|dist/cli/index.js'";
  const list = [
    // An agent whose prompt names a render, the shell that chains the machine check before npm test, npm, the runner.
    {pid: 100, ppid: 1, command: '/opt/homebrew/bin/node /opt/homebrew/bin/codex exec "run node dist/cli/index.js render . --recipe listing"'},
    {pid: 200, ppid: 100, command: `/bin/zsh -c ${check}; npm test`},
    {pid: 300, ppid: 200, command: "npm test"},
    {pid: 900, ppid: 300, command: "/opt/homebrew/bin/node scripts/run-tests.mjs unit integration"},
    // Another session runs the same check before a typecheck.
    {pid: 700, ppid: 1, command: `-zsh -c ${check}; npm run typecheck`},
    {pid: 710, ppid: 700, command: "pgrep -fl Chrome.*--headless|remotion|dist/cli/index.js"},
    // Another session's render, started through sh by npm.
    {pid: 800, ppid: 1, command: "sh -c node dist/cli/index.js render . --recipe listing"},
    {pid: 810, ppid: 800, command: "/opt/homebrew/bin/node /work/se-windows/node_modules/se-widget-studio/dist/cli/index.js render . --recipe listing"}
  ];
  const busy = otherSessionsWork(list, [900]).map((item) => item.pid);
  assert.ok(!busy.includes(100), "the agent that started the runner is the caller's own");
  assert.ok(!busy.includes(700) && !busy.includes(710), "another session's machine check renders nothing");
  assert.deepEqual(busy, [810]);
});

test("the browser gate refuses below 3 GiB free, for orphans and for another session's render, and passes otherwise", async () => {
  const quiet = [{pid: 900, ppid: 1, command: "/opt/homebrew/bin/node scripts/run-tests.mjs"}];
  const gate = (options) => browserGate({root: ROOT, paths: ["/work"], ownRoots: [900], cwd, machine: async () => null, ...options});
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

/** A stand-in for maquina_livre.py that answers `answer` with `exit`; a busy answer also lists its argv. */
async function fakeCheck(t, answer, exit) {
  const folder = await mkdtemp(join(tmpdir(), "sws-machine-check-"));
  t.after(() => rm(folder, {recursive: true, force: true}));
  const script = join(folder, "maquina_livre.py");
  await writeFile(script, [
    "import json, sys",
    `answer = json.loads(${JSON.stringify(JSON.stringify(answer))})`,
    "if not answer['livre']: answer['reasons'].append('argv ' + ' '.join(sys.argv[1:]))",
    "print(json.dumps(answer))",
    `sys.exit(${exit})`
  ].join("\n"));
  return script;
}

test("the machine check answers busy (exit 3) with its reasons for the caller's family, free (exit 0) without, and null when missing or silent", async (t) => {
  const busy = await fakeCheck(t, {livre: false, motivos: ["o jogo está aberto"], reasons: ["the game (Client-Mac-Shipping) is open"]}, 3);
  assert.deepEqual(await machineVerdict([900, 901], busy), {free: false, reasons: ["the game (Client-Mac-Shipping) is open", "argv --json --familia 900 --familia 901"]});
  assert.deepEqual(await machineVerdict([900], await fakeCheck(t, {livre: true, motivos: [], reasons: []}, 0)), {free: true, reasons: []});
  assert.equal(await machineVerdict([900], join(tmpdir(), "sws-no-such-folder", "maquina_livre.py")), null);
  const silent = await fakeCheck(t, {livre: true, reasons: []}, 0);
  await writeFile(silent, "raise SystemExit(3)\n");
  assert.equal(await machineVerdict([900], silent), null);
  assert.equal(parseVerdict('{"livre": "no", "reasons": []}'), null);
});

test("the browser gate follows the machine check, and the process list only where the check is missing", async () => {
  const quiet = [{pid: 900, ppid: 1, command: "/opt/homebrew/bin/node scripts/run-tests.mjs"}];
  const rendering = [...quiet, processes()[1]];
  const asked = [];
  const gate = (machine) => browserGate({root: ROOT, paths: ["/work"], ownRoots: [900], cwd, processes: rendering, free: async () => 10 * 1024 ** 3, machine: async (roots) => { asked.push(roots); return machine; }});
  assert.deepEqual(await gate({free: true, reasons: []}), {ok: true}, "the check already looked at the renders");
  assert.deepEqual(await gate({free: false, reasons: ["12% of memory free, below 30%", "the game (Client-Mac-Shipping) is open"]}), {ok: false, reason: "the machine check says to wait: 12% of memory free, below 30%; the game (Client-Mac-Shipping) is open"});
  assert.match((await gate(null)).reason, /another session is rendering: PID 11 /);
  assert.deepEqual(asked, [[900], [900], [900]], "the check is asked for the runner's family");
});

test("wait-free waits for what the machine check says, and exits 0 once it says free", {timeout: 60_000}, async (t) => {
  const waitFree = fileURLToPath(new URL("../../scripts/wait-free.mjs", import.meta.url));
  const run = async (script) => {
    const child = spawn(process.execPath, [waitFree, "--timeout-min", "0", "--interval-s", "0"], {cwd: fileURLToPath(new URL("../../", import.meta.url)), env: {...process.env, MACHINE_CHECK: script}, stdio: ["ignore", "pipe", "pipe"]});
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const [code] = await once(child, "exit");
    return {code, output};
  };
  const busy = await run(await fakeCheck(t, {livre: false, motivos: [], reasons: ["the game (Client-Mac-Shipping) is open"]}, 3));
  assert.equal(busy.code, 1, busy.output);
  assert.match(busy.output, /Still busy after 0 min: the game \(Client-Mac-Shipping\) is open/);
  const free = await run(await fakeCheck(t, {livre: true, motivos: [], reasons: []}, 0));
  assert.equal(free.code, 0, free.output);
  assert.match(free.output, /^Machine free after 0 check\(s\)\.$/m);
});
