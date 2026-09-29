import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

import {SUITES, execute, gate, leftovers, nodeArgs, suiteEnvironment, suiteForFile, takeBrowserSlot} from "../../scripts/run-tests.mjs";

async function logFile(t) {
  const directory = await mkdtemp(join(tmpdir(), "sws-runner-log-"));
  t.after(() => rm(directory, {recursive: true, force: true}));
  return join(directory, "suite.log");
}

test("suites that start Chrome run one file at a time; every suite bounds a test at two minutes and ends its files", () => {
  const bounded = ["--test", "--test-reporter=spec", "--test-timeout=120000", "--test-force-exit"];
  assert.deepEqual(nodeArgs(SUITES.unit, ["a.test.mjs"]), [...bounded, "a.test.mjs"]);
  assert.deepEqual(nodeArgs(SUITES.integration, ["b.test.mjs"]), [...bounded, "--test-concurrency=1", "b.test.mjs"]);
  assert.deepEqual(nodeArgs(SUITES.web, ["c.test.ts"]), ["--import", "tsx", ...bounded, "--test-skip-pattern=^\\[browser\\] ", "c.test.ts"]);
  assert.deepEqual(nodeArgs(SUITES["web:browser"], ["d.test.ts"]), ["--import", "tsx", ...bounded, "--test-concurrency=1", "--test-name-pattern=^\\[browser\\] ", "d.test.ts"]);
});

test("a web test that calls runJob starts Chrome, so its name starts with [browser] and it runs behind the gate", async () => {
  const directory = new URL("../web/", import.meta.url);
  let checked = 0;
  for (const file of (await readdir(directory)).filter((name) => name.endsWith(".test.ts"))) {
    // Each top-level test starts on a line that begins with `test(` and runs until the next one.
    for (const block of (await readFile(new URL(file, directory), "utf8")).split(/^(?=test\()/m).slice(1)) {
      if (!block.includes("runJob(")) continue;
      checked += 1;
      assert.match(block, /^test\(\s*['"`]\[browser\] /, `${file}: ${block.slice(0, 100)}`);
    }
  }
  assert.ok(checked >= 6, `found ${checked} web tests that call runJob; the split no longer finds them`);
});

test("a repeated file keeps its suite, and only tsx's cache may stay in a suite's temporary folder", () => {
  assert.equal(suiteForFile("tests/integration/tutorial.test.mjs").suite, SUITES.integration);
  assert.equal(suiteForFile("./tests/web/jobs.test.ts").suite, SUITES.web);
  assert.throws(() => suiteForFile("tests/fixtures/runner/tidy.test.mjs"), /Not a test file of a known suite/);
  assert.deepEqual(leftovers(["tsx-501", "studio-fonts-a1b2c3", "playwright_chromiumdev_profile-x"]), ["playwright_chromiumdev_profile-x", "studio-fonts-a1b2c3"]);
});

test("a suite that leaves a folder in its temporary directory fails and names it; a tidy one passes", {timeout: 60_000}, async (t) => {
  const suite = {flags: []};
  const leaky = await logFile(t);
  assert.equal((await execute("leaky", suite, ["tests/fixtures/runner/leaky.test.mjs"], leaky, {echo: false})).code, 1);
  assert.match(await readFile(leaky, "utf8"), /leaky left 1 entry in its temporary folder: leaky-/);
  const tidy = await logFile(t);
  assert.equal((await execute("tidy", suite, ["tests/fixtures/runner/tidy.test.mjs"], tidy, {echo: false})).code, 0);
  assert.match(await readFile(tidy, "utf8"), /# tidy: exit 0 after/);
});

test("a suite runs with its render slot inside its own TMPDIR", {timeout: 60_000}, async (t) => {
  const log = await logFile(t);
  const {code} = await execute("slot-env", {flags: []}, ["tests/fixtures/runner/slot-env.test.mjs"], log, {echo: false});
  assert.equal(code, 0, await readFile(log, "utf8"));
});

test("a test that never settles, in a file whose event loop never empties, ends at its timeout", {timeout: 60_000}, async (t) => {
  const log = await logFile(t);
  const started = Date.now();
  const {code} = await execute("hung", {flags: ["--test-timeout=700"]}, ["tests/fixtures/runner/hung.test.mjs"], log, {echo: false});
  assert.equal(code, 1);
  assert.ok(Date.now() - started < 30_000, `the hung file ended after ${Date.now() - started} ms`);
  assert.match(await readFile(log, "utf8"), /never settles/);
});

async function slotFolder(t) {
  const folder = await mkdtemp(join(tmpdir(), "sws-runner-slot-"));
  t.after(() => rm(folder, {recursive: true, force: true}));
  return join(folder, "render-slot");
}

const exists = (path) => stat(path).then(() => true, () => false);
const ownerPid = async (dir) => JSON.parse(await readFile(join(dir, "owner.json"), "utf8")).pid;

test("a browser suite takes the render slot without waiting, and a held slot skips it naming the holder", {timeout: 30_000}, async (t) => {
  const dir = await slotFolder(t);
  const other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {stdio: "ignore"});
  t.after(() => other.kill("SIGKILL"));
  await mkdir(dir, {recursive: true});
  await writeFile(join(dir, "owner.json"), JSON.stringify({pid: other.pid, repo: "background-creator", command: "npm run stills", startedAt: new Date().toISOString()}));
  const started = Date.now();
  const held = await takeBrowserSlot({dir});
  assert.equal(held.ok, false);
  assert.match(held.reason, new RegExp(`held by pid ${other.pid} \\(background-creator: npm run stills\\)`));
  assert.ok(Date.now() - started < 1000, "a held slot answers at once");

  other.kill("SIGKILL");
  await once(other, "exit");
  const taken = await takeBrowserSlot({dir});
  assert.equal(taken.ok, true, taken.reason);
  assert.equal(await ownerPid(dir), process.pid);
  taken.release();
  assert.equal(await exists(dir), false);
});

test("the gate takes the slot before the machine check and gives it back when the check refuses", async (t) => {
  const saved = process.env.SE_WIDGET_STUDIO_TEST_GATE;
  delete process.env.SE_WIDGET_STUDIO_TEST_GATE;
  t.after(() => { if (saved !== undefined) process.env.SE_WIDGET_STUDIO_TEST_GATE = saved; });
  const dir = await slotFolder(t);
  const take = () => takeBrowserSlot({dir});
  const checked = [];
  const refused = await gate({take, check: async () => { checked.push(await exists(dir)); return {ok: false, reason: "only 2.9 GiB free"}; }, pauseMs: 0});
  assert.deepEqual(refused, {ok: false, reason: "only 2.9 GiB free"});
  assert.deepEqual(checked, [true, true, true], "the machine is checked three times while the suite holds the slot");
  assert.equal(await exists(dir), false, "a refused suite leaves the slot free");
  const allowed = await gate({take, check: async () => ({ok: true}), pauseMs: 0});
  assert.equal(allowed.ok, true);
  assert.equal(await ownerPid(dir), process.pid);
  allowed.release();
  assert.equal(await exists(dir), false);
});

test("a suite's processes get its TMPDIR and a render slot inside it, never the machine's", () => {
  assert.deepEqual(suiteEnvironment({PATH: "/bin", NODE_TEST_CONTEXT: "child-v8", RENDER_SLOT_DIR: "/Users/me/.cache/render-slot"}, "/tmp/sws-abc"), {
    PATH: "/bin",
    TMPDIR: "/tmp/sws-abc",
    RENDER_SLOT_DIR: "/tmp/sws-abc/render-slot"
  });
});
