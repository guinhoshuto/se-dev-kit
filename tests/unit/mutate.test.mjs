// scripts/mutate.mjs on a throwaway git checkout with tiny node:test files: no Chrome, no network.
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import test from "node:test";

import {applySwap, mutate, parseArgs} from "../../scripts/mutate.mjs";

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
