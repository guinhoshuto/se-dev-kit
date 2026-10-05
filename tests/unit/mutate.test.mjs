// scripts/mutate.mjs on a throwaway git checkout with tiny node:test files: no Chrome, no network.
import assert from "node:assert/strict";
import {execFileSync, spawn} from "node:child_process";
import {createHash} from "node:crypto";
import {once} from "node:events";
import {copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import test from "node:test";

import {applySwap, mutate, opensChrome, parseArgs} from "../../scripts/mutate.mjs";
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

async function checkout(t) {
  const root = await mkdtemp(join(tmpdir(), "sws-mutate-"));
  t.after(() => rm(root, {recursive: true, force: true}));
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

async function folder(t, prefix) {
  const path = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(path, {recursive: true, force: true}));
  return path;
}

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
