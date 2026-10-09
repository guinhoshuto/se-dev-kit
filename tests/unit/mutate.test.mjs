// scripts/mutate.mjs on a throwaway git checkout with tiny node:test files: no Chrome, no network.
import assert from "node:assert/strict";
import {execFileSync, spawn, spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {once} from "node:events";
import {readdirSync, rmSync} from "node:fs";
import {copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import test from "node:test";

import {applySwap, mutate, opensChrome, parseArgs, spawnBounded} from "../../scripts/mutate.mjs";
import {gate, takeBrowserSlot} from "../../scripts/run-tests.mjs";

const FILES = {
  "lib/math.mjs": "export const sum = (a, b) => a + b;\nexport const unused = 1;\n",
  "lib/wait.mjs": "export const ready = () => Promise.resolve(true);\n",
  "src/answer.mjs": "export const answer = 42;\n",
  "skills/tool.mjs": "export const tool = 1;\n",
  "tests/math.test.mjs": "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport {sum} from '../lib/math.mjs';\ntest('adds', () => assert.equal(sum(2, 3), 5));\n",
  "tests/wait.test.mjs": "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport {ready} from '../lib/wait.mjs';\ntest('is ready', async () => assert.equal(await ready(), true));\n",
  "tests/answer.test.mjs": "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport {answer} from '../dist/answer.mjs';\ntest('answers', () => assert.equal(answer, 42));\n",
  "tests/red.test.mjs": "import assert from 'node:assert/strict';\nimport test from 'node:test';\ntest('always fails', () => assert.fail('red'));\n"
};
// Uncommitted work under test, like the code a new test is written for: git diff must come back as it was.
const WORK_IN_PROGRESS = "// work in progress\n";
const quiet = () => {};

// A folder's name carries its owner's pid, so a run killed before its t.after (an outer mutate's watchdog kills
// it with SIGKILL) leaves a folder that the next run sweeps.
const alive = pid => {try {process.kill(pid, 0); return true;} catch (error) {return error.code === "EPERM";}};
function sweep(dir = tmpdir()) {
  for (const name of readdirSync(dir)) {
    const owner = /^sws-mutate-[a-z]+-(\d+)-/.exec(name)?.[1];
    if (owner && !alive(Number(owner))) rmSync(join(dir, name), {recursive: true, force: true});
  }
}

async function folder(t, prefix) {
  sweep();
  const path = await mkdtemp(join(tmpdir(), `${prefix}${process.pid}-`));
  t.after(() => rm(path, {recursive: true, force: true}));
  return path;
}

async function checkout(t) {
  const root = await folder(t, "sws-mutate-checkout-");
  for (const [path, text] of Object.entries(FILES)) {
    await mkdir(dirname(join(root, path)), {recursive: true});
    await writeFile(join(root, path), text);
  }
  await mkdir(join(root, "dist"));
  await copyFile(join(root, "src/answer.mjs"), join(root, "dist/answer.mjs"));
  execFileSync("git", ["init", "-q"], {cwd: root, stdio: "ignore"});
  execFileSync("git", ["add", "lib", "src", "skills", "tests"], {cwd: root, stdio: "ignore"});
  await writeFile(join(root, "lib/math.mjs"), FILES["lib/math.mjs"] + WORK_IN_PROGRESS);
  const diff = () => createHash("sha256").update(execFileSync("git", ["diff", "--binary"], {cwd: root})).digest("hex");
  const build = async () => copyFile(join(root, "src/answer.mjs"), join(root, "dist/answer.mjs"));
  return {root, diff, build, read: path => readFile(join(root, path), "utf8")};
}

test("a swap is literal, so $ patterns in the new text survive, and it must match the expected count", () => {
  assert.equal(applySwap("label = 'A'", "'A'", "'$$'"), "label = '$$'");
  assert.equal(applySwap("a-b", "a", "$&$1$`"), "$&$1$`-b");
  assert.equal(applySwap("aa", "a", "b", 2), "bb");
  assert.throws(() => applySwap("x", "y", "z"), /occurs 0 time\(s\), expected 1/);
  assert.throws(() => applySwap("aa", "a", "b"), /occurs 2 time\(s\), expected 1/);
});

test("the CLI takes values that start with -- as code, and keeps --plan apart from a single mutation", () => {
  assert.deepEqual(parseArgs(["lib/x.ts", "--from", "--test-force-exit", "--to", "", "--test", "tests/x.test.mjs"]).mutations,
    [{file: "lib/x.ts", from: "--test-force-exit", to: "", test: "tests/x.test.mjs", name: undefined, occurrences: undefined}]);
  assert.equal(parseArgs(["--plan", "plan.json", "--timeout", "5000"]).timeoutMs, 5000);
  assert.equal(parseArgs(["--plan", "plan.json"]).timeoutMs, 60000);
  assert.throws(() => parseArgs(["--plan", "plan.json", "lib/x.ts"]), /--plan takes every mutation from the file/);
  assert.throws(() => parseArgs(["lib/x.ts", "--from", "a", "--to", "b"]), /--from, --to and --test are required/);
  assert.throws(() => parseArgs(["lib/x.ts", "--from", "a", "--from", "b"]), /only appear once/);
  assert.throws(() => parseArgs(["--plan", "plan.json", "--timeout", "999"]), /--timeout takes milliseconds/);
  assert.throws(() => parseArgs(["--bogus"]), /Unknown option --bogus/);
});

test("a caught mutation is killed, an unchecked one survives, a hang counts as cancelled, and files and git diff come back", async t => {
  const {root, diff, read} = await checkout(t);
  const before = {math: await read("lib/math.mjs"), wait: await read("lib/wait.mjs"), diff: diff()};
  const {code, results} = await mutate([
    {file: "lib/math.mjs", from: "a + b", to: "a - b", test: "tests/math.test.mjs"},
    {file: "lib/math.mjs", from: "unused = 1", to: "unused = 2", test: "tests/math.test.mjs"},
    {file: "lib/wait.mjs", from: "Promise.resolve(true)", to: "new Promise(() => {})", test: "tests/wait.test.mjs"}
  ], {root, timeoutMs: 1000, log: quiet});
  assert.equal(code, 1, "exit code 1: a mutation survived");
  assert.deepEqual(results.map(result => result.killed), [true, false, true]);
  assert.equal(results[0].fail, 1);
  assert.equal(results[1].pass, 1);
  assert.equal(results[2].cancelled, 1, "a test that never settles is cancelled by --test-timeout");
  assert.equal(results[2].timedOut, false, "the test timeout ends the run, not the watchdog");
  assert.equal(await read("lib/math.mjs"), before.math);
  assert.equal(await read("lib/wait.mjs"), before.wait);
  assert.equal(diff(), before.diff, "git diff is as it was");
  assert.deepEqual(await readdir(join(root, ".cache/mutate")), [], "no backup is left behind");
});

test("a src/ mutation rebuilds dist/ before its test and after the restore, and outside a worktree needs --allow-live-checkout", async t => {
  const {root, build, read} = await checkout(t);
  const mutation = {file: "src/answer.mjs", from: "42", to: "41", test: "tests/answer.test.mjs"};
  await assert.rejects(mutate([mutation], {root, build, log: quiet}), /are live for every agent session/);
  await assert.rejects(mutate([{file: "skills/tool.mjs", from: "1", to: "2", test: "tests/math.test.mjs"}], {root, log: quiet}), /are live for every agent session/, "skills/ is live too");
  const {code, results} = await mutate([mutation], {root, build, allowLiveCheckout: true, timeoutMs: 5000, log: quiet});
  assert.equal(code, 0, "exit code 0: every mutation was killed");
  assert.equal(results[0].killed, true, "the test saw the mutant only through the rebuilt dist/");
  assert.equal(await read("src/answer.mjs"), FILES["src/answer.mjs"]);
  assert.equal(await read("dist/answer.mjs"), FILES["src/answer.mjs"], "dist/ is rebuilt from the restored source");
});

test("setup errors change nothing: a missing literal, a red baseline, a backup left by a crashed run", async t => {
  const {root, read} = await checkout(t);
  const math = await read("lib/math.mjs");
  await assert.rejects(mutate([{file: "lib/math.mjs", from: "a * b", to: "a / b", test: "tests/math.test.mjs"}], {root, log: quiet}), /lib\/math\.mjs: "from" occurs 0 time/);
  await assert.rejects(mutate([{file: "lib/math.mjs", from: "a + b", to: "a - b", test: "tests/red.test.mjs"}], {root, timeoutMs: 5000, log: quiet}), /is not green before any mutation/);
  await mkdir(join(root, ".cache/mutate"), {recursive: true});
  await writeFile(join(root, ".cache/mutate/lib__math.mjs.orig"), "crashed run");
  await assert.rejects(mutate([{file: "lib/math.mjs", from: "a + b", to: "a - b", test: "tests/math.test.mjs"}], {root, log: quiet}), /A previous run left/);
  assert.equal(await read("lib/math.mjs"), math);
});

const exists = path => stat(path).then(() => true, () => false);

// A test under tests/integration that would start Chrome; this one only leaves a mark that it ran.
const CHROME_TEST = "import assert from 'node:assert/strict';\nimport {writeFileSync} from 'node:fs';\nimport test from 'node:test';\nimport {value} from '../../lib/value.mjs';\ntest('stands in for a Chrome test', () => {\n  writeFileSync(new URL('../../ran', import.meta.url), 'ran');\n  assert.equal(value, 1);\n});\n";

/** A throwaway checkout holding copies of the scripts the mutate CLI loads, so the CLI's ROOT is that checkout. */
async function cliCheckout(t) {
  const root = await folder(t, "sws-mutate-cli-");
  for (const path of ["scripts/mutate.mjs", "scripts/run-tests.mjs", "scripts/lib/machine.mjs", "dist/shared/render-slot.js"]) {
    await mkdir(dirname(join(root, path)), {recursive: true});
    await copyFile(new URL(`../../${path}`, import.meta.url), join(root, path));
  }
  await writeFile(join(root, "package.json"), JSON.stringify({type: "module"}));
  await mkdir(join(root, "lib"));
  await writeFile(join(root, "lib/value.mjs"), "export const value = 1;\n");
  await mkdir(join(root, "tests/integration"), {recursive: true});
  await writeFile(join(root, "tests/integration/opens-chrome.test.mjs"), CHROME_TEST);
  // A machine check that always says free, so only the slot can stop the run.
  await writeFile(join(root, "free-machine.py"), "import json\nprint(json.dumps({'livre': True, 'reasons': []}))\n");
  execFileSync("git", ["init", "-q"], {cwd: root, stdio: "ignore"});
  execFileSync("git", ["add", "."], {cwd: root, stdio: "ignore"});
  return root;
}

test("with the render slot held by another process, the CLI stops a mutation whose test starts Chrome before anything runs, naming the holder", {timeout: 60_000}, async t => {
  const root = await cliCheckout(t);
  const slot = join(await folder(t, "sws-mutate-slot-"), "render-slot");
  const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {stdio: "ignore"});
  t.after(() => holder.kill("SIGKILL"));
  await mkdir(slot);
  await writeFile(join(slot, "owner.json"), JSON.stringify({pid: holder.pid, repo: "background-creator", command: "npm run stills", startedAt: new Date().toISOString()}));
  const env = {...process.env, RENDER_SLOT_DIR: slot, MACHINE_CHECK: join(root, "free-machine.py")};
  for (const name of ["NODE_TEST_CONTEXT", "RENDER_SLOT_HELD", "SE_WIDGET_STUDIO_TEST_GATE"]) delete env[name];
  const cli = spawn(process.execPath, ["scripts/mutate.mjs", "lib/value.mjs", "--from", "1", "--to", "2", "--test", "tests/integration/opens-chrome.test.mjs"], {cwd: root, env, stdio: ["ignore", "pipe", "pipe"]});
  let output = "";
  cli.stdout.on("data", chunk => {output += chunk;});
  cli.stderr.on("data", chunk => {output += chunk;});
  const [code] = await once(cli, "close");
  assert.equal(code, 2, output);
  assert.match(output, /tests\/integration\/opens-chrome\.test\.mjs starts Chrome, and the machine is not free for it/);
  assert.match(output, new RegExp(`held by pid ${holder.pid} \\(background-creator: npm run stills\\)`));
  assert.equal(await exists(join(root, "ran")), false, "the test that starts Chrome never ran, not even its baseline");
  assert.equal(await readFile(join(root, "lib/value.mjs"), "utf8"), "export const value = 1;\n");
  assert.equal(JSON.parse(await readFile(join(slot, "owner.json"), "utf8")).pid, holder.pid, "the slot stays with its holder");
});

test("a mutation whose test starts Chrome runs holding the render slot, which its test inherits, and gives the slot back", {timeout: 60_000}, async t => {
  const saved = process.env.SE_WIDGET_STUDIO_TEST_GATE;
  delete process.env.SE_WIDGET_STUDIO_TEST_GATE;
  t.after(() => {if (saved !== undefined) process.env.SE_WIDGET_STUDIO_TEST_GATE = saved;});
  const {root, read} = await checkout(t);
  const slot = join(await folder(t, "sws-mutate-slot-"), "render-slot");
  // Each run notes who owns the slot as it starts, and which owner it inherited.
  await mkdir(join(root, "tests/integration"));
  await writeFile(join(root, "tests/integration/sum.test.mjs"), [
    "import assert from 'node:assert/strict';",
    "import {appendFileSync, readFileSync} from 'node:fs';",
    "import test from 'node:test';",
    "import {sum} from '../../lib/math.mjs';",
    "test('adds', () => {",
    `  const owner = JSON.parse(readFileSync(${JSON.stringify(join(slot, "owner.json"))}, 'utf8')).pid;`,
    "  appendFileSync(new URL('../../seen.txt', import.meta.url), `${owner} ${process.env.RENDER_SLOT_HELD}\\n`);",
    "  assert.equal(sum(2, 3), 5);",
    "});",
    ""
  ].join("\n"));
  const machine = () => gate({take: () => takeBrowserSlot({dir: slot}), check: async () => ({ok: true}), pauseMs: 0});
  const {code, results} = await mutate([{file: "lib/math.mjs", from: "a + b", to: "a - b", test: "tests/integration/sum.test.mjs"}], {root, machine, timeoutMs: 5000, log: quiet});
  assert.equal(code, 0);
  assert.equal(results[0].killed, true);
  assert.equal(results[0].fail, 1, "the mutant failed its assertion, not its slot check");
  const runs = (await read("seen.txt")).trim().split("\n");
  assert.deepEqual(runs, [`${process.pid} ${process.pid}`, `${process.pid} ${process.pid}`], "the baseline and the mutant ran while this process held the slot, which they inherited");
  assert.equal(await exists(slot), false, "the slot is free once the run ends");
});

test("a mutation whose test starts no Chrome runs while the machine is busy, without asking it", {timeout: 60_000}, async t => {
  const {root} = await checkout(t);
  let asked = 0;
  const machine = async () => {asked += 1; return {ok: false, reason: "the game is open"};};
  const {code} = await mutate([{file: "lib/math.mjs", from: "a + b", to: "a - b", test: "tests/math.test.mjs"}], {root, machine, timeoutMs: 5000, log: quiet});
  assert.equal(code, 0);
  assert.equal(asked, 0);
  assert.equal(opensChrome("tests/integration/capture.test.mjs"), true);
  assert.equal(opensChrome("tests/unit/mutate.test.mjs"), false);
  assert.equal(opensChrome("tests/web/jobs.test.ts"), false, "mutate skips the [browser] web tests, so the rest of a web file starts no Chrome");
});

// Nothing a run starts outlives it (THB-21 in etsy-thumb-generator): the processes below name the checkout on their
// command line, and the grandchild runs detached, in a group of its own, as Playwright starts Chrome.
const table = () => execFileSync("ps", ["-axo", "pid=,ppid=,command="], {encoding: "utf8"}).trim().split("\n")
  .map(line => {const [pid, ppid, ...command] = line.trim().split(/\s+/); return {pid: Number(pid), ppid: Number(ppid), command: command.join(" ")};});
const processesOf = root => table().filter(row => row.command.includes(root) && row.pid > 1 && row.pid !== process.pid).map(row => row.pid);
function descendants(pid) {
  const rows = table();
  const tree = [pid];
  for (let i = 0; i < tree.length; i++) tree.push(...rows.filter(row => row.ppid === tree[i]).map(row => row.pid));
  return tree.slice(1);
}
const living = pids => {const all = new Set(table().map(row => row.pid)); return pids.filter(pid => all.has(pid));};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await pause(100)) if (check()) return true;
  return check();
}
function reapAfter(t, pids) {
  t.after(() => {for (const pid of [...pids()]) {try {process.kill(pid, "SIGKILL");} catch { /* gone */ }}});
}
const GRANDCHILD = marker => `require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', ${JSON.stringify(marker)}], {detached: true, stdio: ['ignore', 'inherit', 'inherit']}).unref();`;
// A grandchild left in the run's group by a parent that exits at once: launchd adopts it before the leash notes it.
const ORPHAN = (marker, cp = "require('node:child_process')") => `${cp}.spawn(process.execPath, ['-e', ${JSON.stringify(`require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', ${JSON.stringify(marker)}, 'orphan'], {stdio: 'ignore'}); process.exit(0);`)}], {stdio: 'ignore'});`;

test("a folder whose owner died is swept when the next is made, and one whose owner lives is kept", async t => {
  const dead = spawnSync(process.execPath, ["-e", ""]).pid;
  const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {stdio: "ignore"});
  t.after(() => holder.kill("SIGKILL"));
  const names = {dead: `sws-mutate-checkout-${dead}-x`, living: `sws-mutate-checkout-${holder.pid}-x`, launchd: "sws-mutate-checkout-1-x"};
  for (const name of Object.values(names)) {
    await mkdir(join(tmpdir(), name));
    t.after(() => rm(join(tmpdir(), name), {recursive: true, force: true}));
  }
  assert.equal(alive(dead), false, "the dead owner's pid is free");
  await folder(t, "sws-mutate-checkout-");
  assert.equal(await exists(join(tmpdir(), names.dead)), false, "the dead owner's folder is gone");
  assert.equal(await exists(join(tmpdir(), names.living)), true, "a living owner's folder stays");
  assert.equal(await exists(join(tmpdir(), names.launchd)), true, "an owner this user may not signal (EPERM) counts as alive");
});

test("the watchdog stops a hung run and everything it started, a detached grandchild and an orphan in its group included", {timeout: 30_000}, async t => {
  const root = await folder(t, "sws-mutate-hang-");
  reapAfter(t, () => processesOf(root));
  const started = Date.now();
  const running = spawnBounded(process.execPath, ["-e", `${GRANDCHILD(root)} ${ORPHAN(root)} setInterval(() => {}, 1000);`, root], {cwd: root, limitMs: 3000});
  const orphaned = await until(() => table().some(row => row.ppid === 1 && row.command.includes(root) && row.command.endsWith(" orphan")), 2500);
  const run = await running;
  assert.ok(orphaned, "the orphan was adopted by launchd while the run hung");
  assert.equal(run.timedOut, true, "the watchdog fired");
  assert.ok(Date.now() - started < 10_000, `the run ended ${Date.now() - started} ms after it started`);
  assert.ok(await until(() => !processesOf(root).length, 5000), `still running: ${processesOf(root)}`);
});

test("a run that exits leaving a child on its output pipe ends, and the child is gone", {timeout: 30_000}, async t => {
  const root = await folder(t, "sws-mutate-stray-");
  reapAfter(t, () => processesOf(root));
  const run = await Promise.race([
    spawnBounded(process.execPath, ["-e", `${GRANDCHILD(root)} setTimeout(() => process.exit(0), 1500);`, root], {cwd: root, limitMs: 20_000}),
    pause(15_000).then(() => "hung")
  ]);
  assert.notEqual(run, "hung", "the run ended although its child held the output pipe");
  assert.equal(run.exitCode, 0);
  assert.equal(run.timedOut, false);
  assert.ok(await until(() => !processesOf(root).length, 5000), `still running: ${processesOf(root)}`);
});

test("mutate killed with SIGKILL mid-hang takes its test run, the detached grandchild and an orphan in its group with it", {timeout: 60_000}, async t => {
  const {root} = await checkout(t);
  const hang = {file: "lib/wait.mjs", from: "Promise.resolve(true)", to: `(import('node:child_process').then(c => {c.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', ${JSON.stringify(root)}], {detached: true, stdio: 'ignore'}); ${ORPHAN(root, "c")}}), new Promise(() => {}))`, test: "tests/wait.test.mjs"};
  const script = `import {mutate} from ${JSON.stringify(new URL("../../scripts/mutate.mjs", import.meta.url).href)}; await mutate([${JSON.stringify(hang)}], {root: ${JSON.stringify(root)}, timeoutMs: 60000, log: () => {}});`;
  const driver = spawn(process.execPath, ["--input-type=module", "-e", script], {stdio: "ignore"});
  let tree = [];
  reapAfter(t, () => [driver.pid, ...tree, ...processesOf(root)]);
  const hanging = await until(() => {
    tree = descendants(driver.pid);
    const rows = table();
    return rows.some(row => tree.includes(row.pid) && row.command.includes("setInterval") && row.command.includes(root))
      && rows.some(row => row.ppid === 1 && row.command.includes(root) && row.command.endsWith(" orphan"));
  }, 20_000);
  assert.ok(hanging, `the mutant's grandchild and orphan never started: ${JSON.stringify(tree)}`);
  assert.ok(tree.length >= 4, `the leash, the runner, the test file and the grandchild: ${JSON.stringify(tree)}`);
  driver.kill("SIGKILL");
  assert.ok(await until(() => !living(tree).length && !processesOf(root).length, 5000), `still running: ${living(tree)} ${processesOf(root)}`);
});
