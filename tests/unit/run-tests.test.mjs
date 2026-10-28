import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {existsSync} from "node:fs";
import {mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {setTimeout as sleep} from "node:timers/promises";

import {SUITES, execute, gate, leftovers, nodeArgs, runSuites, suiteEnvironment, suiteForFile, takeBrowserSlot} from "../../scripts/run-tests.mjs";

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
const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Another process's hold on the slot at `dir`: a live pid in its owner.json, as background-creator writes it. */
async function holdSlot(t, dir) {
  const other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {stdio: "ignore"});
  t.after(() => other.kill("SIGKILL"));
  await mkdir(dir, {recursive: true});
  await writeFile(join(dir, "owner.json"), JSON.stringify({pid: other.pid, repo: "background-creator", command: "npm run stills", startedAt: new Date().toISOString()}));
  return other;
}

/** The test runner's gate keeps its own environment switch; these tests need it on. */
function gateOn(t) {
  const saved = process.env.SE_WIDGET_STUDIO_TEST_GATE;
  delete process.env.SE_WIDGET_STUDIO_TEST_GATE;
  t.after(() => { if (saved !== undefined) process.env.SE_WIDGET_STUDIO_TEST_GATE = saved; });
}

test("a browser suite waits in the queue for a held render slot and takes it when the holder lets go; a holder that never does ends the wait naming it", {timeout: 30_000}, async (t) => {
  const dir = await slotFolder(t);
  const other = await holdSlot(t, dir);
  const started = Date.now();
  const held = await takeBrowserSlot({dir, wait: false});
  assert.equal(held.ok, false);
  assert.match(held.reason, new RegExp(`held by pid ${other.pid} \\(background-creator: npm run stills\\)`));
  assert.ok(Date.now() - started < 1000, "without wait, a held slot answers at once");

  const timedOut = await takeBrowserSlot({dir, pollMs: 50, waitLimitMs: 300, log: () => {}});
  assert.equal(timedOut.ok, false);
  assert.match(timedOut.reason, new RegExp(`Gave up after \\d+ minutes waiting for the render slot \\(${literal(dir)}\\), held by pid ${other.pid} \\(background-creator: npm run stills\\)`));

  const said = [];
  const waiting = takeBrowserSlot({dir, pollMs: 50, log: (message) => said.push(message)});
  await sleep(500);
  assert.equal(await ownerPid(dir), other.pid, "the slot stays with its holder while it holds it");
  // The holder lets go between two of its steps, as a mutation chain of the vault does.
  await rm(dir, {recursive: true, force: true});
  const taken = await waiting;
  assert.equal(taken.ok, true, taken.reason);
  assert.equal(await ownerPid(dir), process.pid);
  assert.match(said.join("\n"), new RegExp(`Waiting for the render slot, held by pid ${other.pid}`));
  const owner = JSON.parse(await readFile(join(dir, "owner.json"), "utf8"));
  assert.deepEqual([owner.repo, owner.protocol], ["se-dev-kit", 2], "the owner names this repo, not the package or the folder");
  taken.release();
  assert.equal(await exists(dir), false);
});

test("while the machine is busy the gate gives the slot back and asks again in its place, then runs; it gives up at its limit, and without wait at once", {timeout: 30_000}, async (t) => {
  gateOn(t);
  const dir = await slotFolder(t);
  const take = (options) => takeBrowserSlot({...options, dir, log: () => {}});
  const busy = {ok: false, wait: true, reason: "another session is rendering: PID 11 npx remotion render"};
  let checks = 0;
  const said = [];
  const allowed = await gate({take, check: async () => (++checks <= 3 ? busy : {ok: true}), pauseMs: 0, backoffMs: 20, log: (message) => said.push([message, existsSync(dir)])});
  assert.equal(allowed.ok, true, allowed.reason);
  assert.equal(checks, 4, "three checks on the first hold, one on the second");
  assert.deepEqual(said, [["The machine is busy: another session is rendering: PID 11 npx remotion render. Gave the slot back; asking again in 0.02 s, in the place it first came.", false]], "the slot is free while the gate waits");
  assert.equal(await ownerPid(dir), process.pid);
  assert.ok(allowed.waitedMs >= 20, `waited ${allowed.waitedMs} ms`);
  allowed.release();

  const game = {ok: false, wait: true, reason: "the machine check says to wait: the game is open"};
  const stuck = await gate({take, check: async () => game, pauseMs: 0, backoffMs: 20, waitLimitMs: 200, log: () => {}});
  assert.equal(stuck.ok, false);
  assert.match(stuck.reason, /^the machine check says to wait: the game is open; gave up after 0\.\d s, giving the slot back \d+×$/);
  assert.equal(await exists(dir), false);

  // The slot taken by someone else while the gate waited out the busy machine: the refusal says both.
  let takes = 0;
  const lost = await gate({take: async (options) => (++takes === 1 ? take(options) : {ok: false, reason: "Gave up after 240 minutes waiting for the render slot, held by pid 7."}), check: async () => game, pauseMs: 0, backoffMs: 20, log: () => {}});
  assert.match(lost.reason, /^Gave up after 240 minutes waiting for the render slot, held by pid 7\. It had given the slot back 1× since \S+, the machine busy: the machine check says to wait: the game is open\.$/);

  checks = 0;
  // A limit of its own, so a gate that waited anyway would end with more checks, not hang.
  const once = await gate({take, check: async () => { checks += 1; return game; }, pauseMs: 0, backoffMs: 20, waitLimitMs: 500, wait: false, log: () => {}});
  assert.deepEqual([once.ok, once.reason, checks], [false, game.reason, 3], "without wait, one hold and its three checks");
  assert.equal(await exists(dir), false);
});

test("npm test waits for a held slot, then runs integration and web:browser holding it; a holder that never lets go leaves them NOT COVERED with the wait and the holder", {timeout: 30_000}, async (t) => {
  gateOn(t);
  const dir = await slotFolder(t);
  const other = await holdSlot(t, dir);
  const logs = await mkdtemp(join(tmpdir(), "sws-runner-logs-"));
  t.after(() => rm(logs, {recursive: true, force: true}));
  const suites = {integration: {browser: true}, web: {}, "web:browser": {browser: true}};
  const ran = [];
  const options = (waitLimitMs, lines) => ({
    suites,
    files: async () => ["fake.test.mjs"],
    gateFor: () => gate({take: (slot) => takeBrowserSlot({...slot, dir, pollMs: 50, log: () => {}}), check: async () => ({ok: true}), pauseMs: 0, waitLimitMs}),
    // Each suite notes who holds the slot while it runs.
    run: async (name) => { ran.push([name, suites[name].browser ? await ownerPid(dir) : null]); return {code: 0, seconds: 0.5}; },
    newDirectory: async () => logs,
    log: (line) => lines.push(line)
  });
  const stuck = [];
  assert.equal(await runSuites(["integration", "web", "web:browser"], options(200, stuck)), 0);
  assert.deepEqual(ran, [["web", null]]);
  const summary = stuck.join("\n");
  assert.match(summary, new RegExp(`^integration +skipped +Gave up after \\d+ minutes waiting for the render slot \\(${literal(dir)}\\), held by pid ${other.pid} \\(background-creator: npm run stills\\)`, "m"));
  assert.match(summary, /^NOT COVERED: integration, web:browser\./m);

  ran.length = 0;
  const lines = [];
  const release = sleep(1200).then(() => rm(dir, {recursive: true, force: true}));
  assert.equal(await runSuites(["integration", "web", "web:browser"], options(60_000, lines)), 0);
  await release;
  assert.deepEqual(ran, [["integration", process.pid], ["web", null], ["web:browser", process.pid]]);
  const text = lines.join("\n");
  assert.doesNotMatch(text, /NOT COVERED|skipped/);
  assert.match(text, /^integration +passed +0\.5 s, after \d+\.\d s waiting for the render slot$/m);
  assert.match(text, /^web:browser +passed +0\.5 s$/m, "a free slot is no wait");
  assert.equal(await exists(dir), false, "the run gives the slot back");
});

test("a run stops at its first failed suite and names each suite after it NOT COVERED, with the command that runs them", async () => {
  const suites = {unit: {}, integration: {browser: true}, web: {}, "web:browser": {browser: true}};
  const summary = async (failing, refused = []) => {
    const lines = [];
    const ran = [];
    const code = await runSuites(Object.keys(suites), {
      suites,
      files: async () => ["fake.test.mjs"],
      gateFor: async () => (refused.length ? {ok: false, reason: refused.shift()} : {ok: true, release: () => {}}),
      run: async (name) => { ran.push(name); return {code: name === failing ? 1 : 0, seconds: 0.5}; },
      // Nothing is written there: run is fake.
      newDirectory: async () => join(tmpdir(), "sws-runner-unused"),
      log: (line) => lines.push(line)
    });
    return {code, ran, text: lines.join("\n")};
  };

  // 2026-10-27: unit failed on the render-slot copy and the summary said only "unit failed".
  const first = await summary("unit");
  assert.equal(first.code, 1);
  assert.deepEqual(first.ran, ["unit"], "the run still stops at the failure");
  assert.match(first.text, /^unit +failed +0\.5 s$/m);
  for (const name of ["integration", "web", "web:browser"]) assert.match(first.text, new RegExp(`^${literal(name)} +not run +after unit failed$`, "m"));
  assert.match(first.text, /^NOT COVERED: integration, web, web:browser\. This run did not test them: unit failed and the run stopped there; run them with node scripts\/run-tests\.mjs integration web web:browser\.$/m);

  // A browser suite the gate skipped keeps its own line and command; the suite after the failure gets the other.
  const both = await summary("web", ["only 2.9 GiB free"]);
  assert.deepEqual(both.ran, ["unit", "web"]);
  assert.match(both.text, /^NOT COVERED: integration\. This run did not test them; run npm run wait-free, then npm run test:browser\.$/m);
  assert.match(both.text, /^NOT COVERED: web:browser\. This run did not test them: web failed and the run stopped there; run them with node scripts\/run-tests\.mjs web:browser\.$/m);

  const last = await summary("web:browser");
  assert.deepEqual(last.ran, ["unit", "integration", "web", "web:browser"]);
  assert.doesNotMatch(last.text, /NOT COVERED|not run/, "a failure in the last suite leaves nothing unrun");
});

test("the gate takes the slot before the machine check and gives it back at once when the check refuses for a reason waiting cannot end", async (t) => {
  gateOn(t);
  const dir = await slotFolder(t);
  const take = (options) => takeBrowserSlot({...options, dir});
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
    RENDER_SLOT_DIR: "/tmp/sws-abc/render-slot",
    MACHINE_CHECK: "/tmp/sws-abc/no-machine-check"
  });
});
