import assert from "node:assert/strict";
import {execFileSync, spawn} from "node:child_process";
import {once} from "node:events";
import {existsSync} from "node:fs";
import {mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {basename, join} from "node:path";
import test from "node:test";
import {setTimeout as sleep} from "node:timers/promises";
import {fileURLToPath} from "node:url";

import {historyDir} from "../../dist/shared/render-slot.js";
import {browserGate, diskFloor} from "../../scripts/lib/machine.mjs";
import {LAUNCH_RERUNS, SUITES, execute, gate, leftovers, nodeArgs, runSuites, suiteEnvironment, suiteForFile, takeBrowserSlot} from "../../scripts/run-tests.mjs";
import {failedTests, historyFile, historyReport, launchRetries, launchTimeoutFiles, readHistory} from "../../scripts/lib/test-history.mjs";
import {chainRound, queueHolds} from "../fixtures/runner/ceding-chain.mjs";
import {EXIT, notCoveredSuites, runGate} from "../../scripts/gate.mjs";

// This file runs the runner's own functions: its fake suites stay out of the live checkout's test history.
process.env.TEST_HISTORY_FILE = "off";

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

test("a repeated file keeps its suite, and only tsx's cache and the suite slot's history may stay in a suite's temporary folder", () => {
  assert.equal(suiteForFile("tests/integration/tutorial.test.mjs").suite, SUITES.integration);
  assert.equal(suiteForFile("./tests/web/jobs.test.ts").suite, SUITES.web);
  assert.throws(() => suiteForFile("tests/fixtures/runner/tidy.test.mjs"), /Not a test file of a known suite/);
  assert.deepEqual(leftovers(["tsx-501", "studio-fonts-a1b2c3", "playwright_chromiumdev_profile-x"]), ["playwright_chromiumdev_profile-x", "studio-fonts-a1b2c3"]);
  // The history the slot module writes beside the suite's slot (#23), named as that module names it; a slot still
  // held, its queue or another slot's history is a leftover.
  const history = basename(historyDir(suiteEnvironment({}, "/tmp/sws-x").RENDER_SLOT_DIR));
  assert.deepEqual(leftovers([history, "render-slot", "render-slot.queue", "other-slot.historico"]), ["other-slot.historico", "render-slot", "render-slot.queue"]);
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

test("a suite runs with its render slot inside its own TMPDIR, and taking it fails no suite for the history it leaves", {timeout: 60_000}, async (t) => {
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

test("a browser suite waits in the queue for a held render slot and takes it when the holder lets go; a holder that never does ends the wait naming it", {timeout: 30_000}, async (t) => {
  const dir = await slotFolder(t);
  const other = await holdSlot(t, dir);
  const started = Date.now();
  const held = await takeBrowserSlot({dir, wait: false});
  assert.equal(held.ok, false);
  assert.equal(held.wait, true, "waiting can end a held slot's refusal");
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

test("a browser suite that comes while a chain of the harness that cedes holds the slot goes in between two of its rounds, ahead of the round already waiting", {timeout: 60_000}, async (t) => {
  const dir = await slotFolder(t);
  const env = {...process.env, RENDER_SLOT_DIR: dir};
  for (const name of ["RENDER_SLOT_HELD", "RENDER_SLOT_CEDE"]) delete env[name];
  const script = fileURLToPath(new URL("../../dist/shared/render-slot.js", import.meta.url));
  const first = chainRound(t, {script, label: "chain.1", env});
  await first.holding;
  const second = chainRound(t, {script, label: "chain.2", env});
  await queueHolds(dir, 1);
  let secondHeld = false;
  second.holding.then(() => { secondHeld = true; });
  const allowed = gate({take: (options) => takeBrowserSlot({...options, dir, pollMs: 50, log: () => {}}), check: async () => ({ok: true}), pauseMs: 0});
  await queueHolds(dir, 2);
  first.round.kill("SIGTERM");
  const taken = await Promise.race([allowed, sleep(15_000, {ok: false, reason: "no slot within 15 s"}, {ref: false})]);
  assert.equal(taken.ok, true, taken.reason);
  assert.equal(await ownerPid(dir), process.pid);
  assert.equal(secondHeld, false, "the chain's next round, first by place, let the suite go first");
  taken.release();
  await second.holding;
});

test("while the machine is busy the gate gives the slot back and asks again in its place, then runs; it gives up at its limit, and without wait at once", {timeout: 30_000}, async (t) => {
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
  assert.match(summary, /^NOT COVERED: integration, web:browser\. This run did not test them; run npm run test:browser, which waits its turn in the render slot queue\.$/m);

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
  const both = await summary("web", ["Gave up after 240 minutes waiting for the render slot, held by pid 7."]);
  assert.deepEqual(both.ran, ["unit", "web"]);
  assert.match(both.text, /^NOT COVERED: integration\. This run did not test them; run npm run test:browser, which waits its turn in the render slot queue\.$/m);
  assert.match(both.text, /^NOT COVERED: web:browser\. This run did not test them: web failed and the run stopped there; run them with node scripts\/run-tests\.mjs web:browser\.$/m);

  const last = await summary("web:browser");
  assert.deepEqual(last.ran, ["unit", "integration", "web", "web:browser"]);
  assert.doesNotMatch(last.text, /NOT COVERED|not run/, "a failure in the last suite leaves nothing unrun");
});

test("a browser suite the gate skipped is NOT COVERED with the step that runs it: kill-stale or free space first, else npm run test:browser itself, never wait-free", {timeout: 30_000}, async (t) => {
  const dir = await slotFolder(t);
  const root = "/work/se-dev-kit";
  const take = (options) => takeBrowserSlot({...options, dir, log: () => {}});
  const quiet = [{pid: 900, ppid: 1, command: "/opt/homebrew/bin/node scripts/run-tests.mjs"}];
  const orphaned = [...quiet, {pid: 72, ppid: 1, command: `/opt/homebrew/opt/node@24/bin/node ${root}/tests/integration/css-transition.test.mjs`}];
  // The real machine gate behind the real slot, with the disk and the process list replaced.
  const machine = ({free = 10 * 1024 ** 3, processes = quiet}) => () => browserGate({root, paths: ["/work"], ownRoots: [900], processes, free: async () => free, cwd: async () => root, usage: async () => new Map(), machine: async () => ({free: true, reasons: []})});
  const low = () => gate({take, check: machine({free: 3 * 1024 ** 3 - 1}), pauseMs: 0});
  const orphan = () => gate({take, check: machine({processes: orphaned}), pauseMs: 0});
  const timedOut = () => gate({take: async () => ({ok: false, reason: "Gave up after 240 minutes waiting for the render slot, held by pid 7."}), check: machine({}), pauseMs: 0});
  // Each browser suite of the run meets the next gate.
  const summary = async (gates) => {
    const lines = [];
    await runSuites(["integration", "web:browser"], {
      suites: {integration: {browser: true}, "web:browser": {browser: true}},
      files: async () => ["fake.test.mjs"],
      gateFor: () => gates.shift()(),
      run: async (name) => assert.fail(`${name} was skipped and ran`),
      newDirectory: async () => join(tmpdir(), "sws-runner-unused"),
      log: (line) => lines.push(line)
    });
    return lines.join("\n");
  };

  const disk = await summary([low, low]);
  assert.match(disk, /^integration +skipped +only 2\.9 GiB free on the volume of \/work; browser suites need 3\.0 GiB$/m);
  assert.match(disk, /^NOT COVERED: integration, web:browser\. This run did not test them: the disk is low; free some space, then run npm run test:browser\.$/m);
  // Suites skipped for different causes get a line each, in the order they came.
  const mixed = await summary([orphan, timedOut]);
  assert.match(mixed, /^NOT COVERED: integration\. This run did not test them: this checkout left an orphan; run npm run kill-stale, then npm run test:browser\.\nNOT COVERED: web:browser\. This run did not test them; run npm run test:browser, which waits its turn in the render slot queue\.$/m);
  // 2026-10-28: npm run wait-free gives up after 30 minutes while a chain that cedes holds the slot; test:browser waits in the queue and gets in (#16).
  for (const text of [disk, mixed]) assert.doesNotMatch(text, /wait-free/);
  assert.equal(await exists(dir), false, "a skipped suite leaves the slot free");

  // The step's script runs exactly the browser suites, each through this gate's queue.
  const {scripts} = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  assert.match(scripts["test:browser"], new RegExp(`node scripts/run-tests\\.mjs ${Object.keys(SUITES).filter((name) => SUITES[name].browser).join(" ")}$`));
});

test("the gate takes the slot before the machine check and gives it back at once when the check refuses for a reason waiting cannot end", async (t) => {
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

test("the gate's own check holds this checkout's real disk to SE_WIDGET_STUDIO_TEST_MIN_FREE_BYTES inside a test: a floor above its free space refuses as a low disk does", async (t) => {
  assert.ok(process.env.NODE_TEST_CONTEXT, "this file runs as a test file of node --test");
  const saved = process.env.SE_WIDGET_STUDIO_TEST_MIN_FREE_BYTES;
  process.env.SE_WIDGET_STUDIO_TEST_MIN_FREE_BYTES = String(1024 ** 5);
  t.after(() => { if (saved === undefined) delete process.env.SE_WIDGET_STUDIO_TEST_MIN_FREE_BYTES; else process.env.SE_WIDGET_STUDIO_TEST_MIN_FREE_BYTES = saved; });
  let released = 0;
  const refused = await gate({take: async () => ({ok: true, release: () => { released += 1; }}), pauseMs: 0, wait: false});
  const root = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
  assert.equal(refused.ok, false);
  assert.equal(refused.cause, "disk", refused.reason);
  assert.match(refused.reason, new RegExp(`^only \\d+\\.\\d GiB free on the volume of ${literal(root)}; browser suites need 1048576\\.0 GiB$`));
  assert.equal(refused.wait, undefined, "waiting does not free the disk");
  assert.equal(released, 1, "the slot went back");
});

test("a test's disk floor set outside a test refuses the browser suites before the slot is taken, saying why, and leaves them NOT COVERED until it is unset", async (t) => {
  // An npm test a session started with SE_WIDGET_STUDIO_TEST_MIN_FREE_BYTES=0: no NODE_TEST_CONTEXT in its environment (#47).
  const outside = {SE_WIDGET_STUDIO_TEST_MIN_FREE_BYTES: "0"};
  let taken = 0;
  const outsideGate = () => gate({
    floor: () => diskFloor(outside),
    take: async () => { taken += 1; return {ok: true, release: () => {}}; },
    check: async () => assert.fail("the machine was checked"),
    pauseMs: 0
  });
  const reason = "SE_WIDGET_STUDIO_TEST_MIN_FREE_BYTES is set outside a test: only a test (node --test) may stand in for the free disk, and a run outside one keeps the 3 GiB floor of the browser suites";
  const refused = await outsideGate();
  assert.deepEqual(refused, {ok: false, cause: "floor", reason});
  assert.equal(taken, 0, "the slot was never taken");

  const lines = [];
  const code = await runSuites(["integration", "web:browser"], {
    suites: {integration: {browser: true}, "web:browser": {browser: true}},
    files: async () => ["fake.test.mjs"],
    gateFor: outsideGate,
    run: async (name) => assert.fail(`${name} ran`),
    newDirectory: async () => join(tmpdir(), "sws-runner-unused"),
    log: (line) => lines.push(line)
  });
  const summary = lines.join("\n");
  assert.equal(code, 0, "a skipped suite fails no run; the gate's exit 3 names it");
  assert.match(summary, new RegExp(`^integration +skipped +${literal(reason)}$`, "m"));
  assert.match(summary, /^NOT COVERED: integration, web:browser\. This run did not test them: unset SE_WIDGET_STUDIO_TEST_MIN_FREE_BYTES, which only a test may set, then run npm run test:browser\.$/m);
  assert.equal(taken, 0);

  // The floor the gate holds the disk to reaches its check.
  const floors = [];
  const inside = await gate({floor: () => 5, take: async () => ({ok: true, release: () => {}}), check: async (minFreeBytes) => { floors.push(minFreeBytes); return {ok: true}; }, pauseMs: 0});
  assert.equal(inside.ok, true);
  assert.deepEqual(floors, [5]);
});

test("SE_WIDGET_STUDIO_TEST_GATE=off, set outside a test, opens no gate: a browser suite still waits for the render slot, then asks the machine check holding it", {timeout: 30_000}, async (t) => {
  // An npm test or npm run mutate a session started with the switch that once skipped both (#51): the gate runs in a
  // process of its own, with the real slot and no NODE_TEST_CONTEXT, nor the test's disk floor that only a test may set.
  const dir = await slotFolder(t);
  const other = await holdSlot(t, dir);
  const {NODE_TEST_CONTEXT: _context, RENDER_SLOT_HELD: _held, RENDER_SLOT_CEDE: _cede, SE_WIDGET_STUDIO_TEST_MIN_FREE_BYTES: _floor, ...rest} = process.env;
  const env = {...rest, RENDER_SLOT_DIR: dir, SE_WIDGET_STUDIO_TEST_GATE: "off"};
  const outside = async (body) => {
    const script = `import {existsSync} from "node:fs";\nimport {gate} from "./scripts/run-tests.mjs";\n${body}`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {cwd: fileURLToPath(new URL("../../", import.meta.url)), env, stdio: ["ignore", "pipe", "pipe"]});
    let output = "";
    let errors = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { errors += chunk; });
    const [code] = await once(child, "close");
    assert.equal(code, 0, errors);
    return JSON.parse(output.trim().split("\n").at(-1));
  };

  const held = await outside("console.log(JSON.stringify(await gate({wait: false})));");
  assert.equal(held.ok, false, "another process's slot stops the suite");
  assert.equal(held.wait, true, "a refusal that waiting ends, so npm test waits in the queue");
  assert.match(held.reason, new RegExp(`held by pid ${other.pid} \\(background-creator: npm run stills\\)`));
  assert.equal(await ownerPid(dir), other.pid, "the slot stays with its holder");

  // The holder lets go: the gate takes the slot, asks the machine check with it in hand, and gives it back at the refusal.
  await rm(dir, {recursive: true, force: true});
  const busy = "the machine check says to wait: the game is open";
  const checked = await outside(`const held = [];
const result = await gate({wait: false, pauseMs: 0, check: async () => { held.push(existsSync(${JSON.stringify(dir)})); return {ok: false, wait: true, reason: ${JSON.stringify(busy)}}; }});
console.log(JSON.stringify({...result, held}));`);
  assert.deepEqual(checked, {ok: false, wait: true, reason: busy, held: [true, true, true]});
  assert.equal(await exists(dir), false, "the refused suite gave the slot back");
});

test("a suite's processes get its TMPDIR and a render slot inside it, never the machine's", () => {
  assert.deepEqual(suiteEnvironment({PATH: "/bin", NODE_TEST_CONTEXT: "child-v8", RENDER_SLOT_DIR: "/Users/me/.cache/render-slot"}, "/tmp/sws-abc"), {
    PATH: "/bin",
    TMPDIR: "/tmp/sws-abc",
    RENDER_SLOT_DIR: "/tmp/sws-abc/render-slot",
    MACHINE_CHECK: "/tmp/sws-abc/no-machine-check",
    TEST_HISTORY_FILE: "off"
  });
});

test("a suite's log gives the tests that failed and the launches it retried, as the reporter and the launch print them", {timeout: 60_000}, async (t) => {
  const failing = await logFile(t);
  const outcome = await execute("failing", {flags: []}, ["tests/fixtures/runner/failing.test.mjs"], failing, {echo: false});
  assert.equal(outcome.code, 1);
  assert.deepEqual(outcome.failures, [{
    file: "tests/fixtures/runner/failing.test.mjs",
    test: "reads the frame at the change instant",
    error: "AssertionError [ERR_ASSERTION]: at 300 ms the plain box is 247, not 255"
  }]);
  assert.deepEqual(outcome.launchRetries, []);

  const retried = await logFile(t);
  const second = await execute("retried", {flags: []}, ["tests/fixtures/runner/launch-retry.test.mjs"], retried, {echo: false});
  assert.equal(second.code, 0, await readFile(retried, "utf8"));
  assert.deepEqual(second.failures, []);
  assert.equal(second.launchRetries.length, 1);
  assert.match(second.launchRetries[0], /^Chrome launch retried: Chrome did not start within 0\.5 s .*; load \d+\.\d on \d+ cores\.$/);

  // The two parsers on the text a run of 2026-11-04 left, with the real reporter's layout.
  const log = "✔ other (1.2ms)\n\n✖ failing tests:\n\ntest at tests/integration/capture.test.mjs:9:1\n✖ without FFmpeg (38678.8ms)\n  Error [StudioError]: Chrome did not start within 30 s (/Chrome).\n      at launch\n\ntest at tests/integration/css-transition.test.mjs:64:1\n✖ a video draws (4949.7ms)\n  AssertionError [ERR_ASSERTION]: at 300 ms the plain box is 247, not 255\n";
  assert.deepEqual(failedTests(log).map((failure) => [failure.file, failure.test, failure.error]), [
    ["tests/integration/capture.test.mjs", "without FFmpeg", "Error [StudioError]: Chrome did not start within 30 s (/Chrome)."],
    ["tests/integration/css-transition.test.mjs", "a video draws", "AssertionError [ERR_ASSERTION]: at 300 ms the plain box is 247, not 255"]
  ]);
  assert.deepEqual(failedTests("✔ all passed\n"), []);
  assert.deepEqual(launchRetries("a\nChrome launch retried: why one\nb\nChrome launch retried: why two\n"), ["Chrome launch retried: why one", "Chrome launch retried: why two"]);
});

test("a run's summary says a suite retried a Chrome launch and why, and the history keeps every suite's end, to count the next failure", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "sws-history-"));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const file = join(directory, "nested", "test-history.jsonl");
  process.env.TEST_HISTORY_FILE = file;
  t.after(() => { process.env.TEST_HISTORY_FILE = "off"; });
  const why = "Chrome launch retried: Chrome did not start within 30 s (/Chrome). That process was killed and Chrome starts once more; load 12.4 on 8 cores.";
  const failure = {file: "tests/integration/css-transition.test.mjs", test: "a video draws", error: "at 300 ms the plain box is 247, not 255"};
  const outcomes = {
    unit: {code: 0, seconds: 1.5},
    integration: {code: 0, seconds: 460, launchRetries: [why]},
    "web:browser": {code: 1, seconds: 9, failures: [failure]}
  };
  const lines = [];
  const code = await runSuites(Object.keys(outcomes), {
    suites: {unit: {}, integration: {browser: true}, "web:browser": {browser: true}},
    files: async () => ["fake.test.mjs"],
    gateFor: async () => ({ok: true, release: () => {}, waitedMs: 2000}),
    run: async (name) => outcomes[name],
    newDirectory: async () => join(tmpdir(), "sws-runner-unused"),
    log: (line) => lines.push(line)
  });
  assert.equal(code, 1);
  const text = lines.join("\n");
  assert.match(text, /^integration +passed +460\.0 s, after 2\.0 s waiting for the render slot, retrying a Chrome launch 1×$/m);
  assert.ok(lines.includes(`integration: ${why}`), text);
  assert.match(text, /^unit +passed +1\.5 s$/m, "a suite without a retry says nothing of one");

  const entries = (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(entries.map((entry) => [entry.suite, entry.status, entry.launchRetries, entry.failures]), [
    ["unit", "passed", 0, []],
    ["integration", "passed", 1, []],
    ["web:browser", "failed", 0, [failure]]
  ]);
  const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], {encoding: "utf8"}).trim();
  for (const entry of entries) {
    assert.equal(entry.commit, head);
    assert.equal(entry.node, process.version);
    assert.ok(Number.isFinite(entry.load));
    assert.ok(!Number.isNaN(Date.parse(entry.at)), entry.at);
  }
  assert.match(entries[0].log, /sws-runner-unused\/unit\.log$/);
  assert.equal(entries[1].waitedMs, 2000);

  // A skipped suite counts too: the run did not test it.
  await runSuites(["integration"], {
    suites: {integration: {browser: true}},
    files: async () => ["fake.test.mjs"],
    gateFor: async () => ({ok: false, reason: "only 2.1 GiB free"}),
    run: async () => assert.fail("skipped"),
    newDirectory: async () => join(tmpdir(), "sws-runner-unused"),
    log: () => {}
  });
  const report = historyReport(await readHistory(file), "history");
  assert.match(report, /^history: 4 suite run\(s\) from \d{4}-\d\d-\d\d to \d{4}-\d\d-\d\d\.$/m);
  assert.match(report, /^integration: 2 run\(s\), 1 passed, 0 failed, 1 skipped; a Chrome launch retried in 1$/m);
  assert.match(report, /^web:browser: 1 run\(s\), 0 passed, 1 failed, 0 skipped$/m);
  assert.match(report, /^ {2}1× tests\/integration\/css-transition\.test\.mjs: a video draws; last on \d{4}-\d\d-\d\d: at 300 ms the plain box is 247, not 255$/m);
});

test("a browser suite whose Chrome launch times out twice asks the machine check again: told to wait, it gives the slot back, waits, runs that file again and passes, naming the wait; told the machine is free, it fails as before", {timeout: 120_000}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "sws-launch-wait-"));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const starts = join(directory, "chrome-starts");
  process.env.SWS_FAKE_LAUNCH_STARTS = starts;
  t.after(() => { delete process.env.SWS_FAKE_LAUNCH_STARTS; });
  const history = join(directory, "history.jsonl");
  process.env.TEST_HISTORY_FILE = history;
  t.after(() => { process.env.TEST_HISTORY_FILE = "off"; });
  const fixture = "tests/fixtures/runner/launch-timeout.test.mjs";
  let holding = false;
  const holds = [];
  const take = async () => { holds.push(holding); holding = true; return {ok: true, release: () => { holding = false; }}; };
  const ran = [];
  const suiteRun = async (name, suite, list, logPath) => { ran.push([list, basename(logPath), holding]); return execute(name, suite, list, logPath, {echo: false}); };
  const runWith = async (check, logs) => {
    const lines = [];
    const code = await runSuites(["integration"], {
      suites: {integration: {browser: true, flags: []}},
      files: async () => [fixture],
      gateFor: (options) => gate({...options, take, floor: () => 0, check, pauseMs: 0, backoffMs: 20, log: () => {}}),
      run: suiteRun,
      newDirectory: async () => { await mkdir(logs); return logs; },
      log: (line) => lines.push(line)
    });
    return {code, text: lines.join("\n")};
  };

  // Free at the suite's start; after the two timeouts, busy for one hold's three checks, then free, and Chrome starts.
  const busy = {ok: false, wait: true, reason: "the machine check says to wait: load 31.6 on 8 cores"};
  let checks = 0;
  const waiting = await runWith(async () => {
    checks += 1;
    if (checks === 1) return {ok: true};
    if (checks <= 4) return busy;
    await writeFile(starts, "");
    return {ok: true};
  }, join(directory, "waits"));
  assert.equal(waiting.code, 0, waiting.text);
  assert.equal(checks, 5);
  assert.deepEqual(ran, [[[fixture], "integration.log", true], [[fixture], "integration-again-1.log", true]], "the file runs again, in a log of its own, holding the slot");
  assert.deepEqual(holds, [false, false, false], "the slot was given back after the timeout and while the machine was busy");
  assert.equal(holding, false);
  assert.match(waiting.text, /^integration +passed +\d+\.\d s, retrying a Chrome launch 1×, running a file again after a Chrome launch timed out 1×$/m);
  assert.match(waiting.text, new RegExp(`^integration: Chrome's launch timed out twice in ${literal(fixture)}; the machine check said to wait \\(${literal(busy.reason)}\\), so it waited \\d+\\.\\d s and ran it again: passed\\.$`, "m"));
  assert.match(waiting.text, /^integration: Chrome launch retried: Chrome did not start within 0\.3 s /m);

  // Free when asked again: two timeouts fail the suite, as before the wait existed.
  await rm(starts, {force: true});
  ran.length = 0;
  holds.length = 0;
  const free = await runWith(async () => ({ok: true}), join(directory, "free"));
  assert.equal(free.code, 1, free.text);
  assert.deepEqual(ran.map(([, log]) => log), ["integration.log"]);
  assert.equal(holding, false);
  assert.match(free.text, /^integration +failed +\d+\.\d s, retrying a Chrome launch 1×$/m);
  assert.ok(free.text.includes(`integration: Chrome's launch timed out twice in ${fixture}; not run again: the machine check says the machine is free, so waiting would not mend the launch.`), free.text);

  const entries = (await readFile(history, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(entries.map((entry) => [entry.status, entry.launchRetries, entry.failures.map((failure) => failure.file)]), [["passed", 1, []], ["failed", 1, [fixture]]]);
  const [wait] = entries[0].launchWaits;
  assert.deepEqual({...wait, waitedMs: wait.waitedMs >= 20}, {files: [fixture], waitedMs: true, why: busy.reason, log: wait.log, status: "passed"});
  assert.match(wait.log, /waits\/integration-again-1\.log$/);
  assert.equal(entries[1].launchWaits, undefined);
});

test("a file whose launch keeps timing out runs again at most LAUNCH_RERUNS times; another failure, any leftover (a launch profile too), no retried launch or a suite without Chrome runs nothing again", async () => {
  const file = "tests/integration/session-update.test.mjs";
  const timedOut = {code: 1, seconds: 1, launchRetries: ["Chrome launch retried: why"], launchTimeouts: [file], left: [], failures: [{file, test: "t", error: "Error [StudioError]: Chrome did not start within 30 s (/Chrome)."}]};
  const attempt = async (outcome, suites = {integration: {browser: true}, "web:browser": {browser: true}}) => {
    const asked = [];
    const lists = [];
    const lines = [];
    const code = await runSuites(Object.keys(suites), {
      suites,
      files: async () => ["fake.test.mjs"],
      gateFor: async (options) => { asked.push(options); return {ok: true, release: () => {}, waitedMs: 90_000, busy: "load 40.1 on 8 cores"}; },
      run: async (name, suite, list) => { lists.push(list); return outcome; },
      newDirectory: async () => join(tmpdir(), "sws-runner-unused"),
      log: (line) => lines.push(line)
    });
    return {code, runs: lists.length, lists, asked, text: lines.join("\n")};
  };
  assert.equal(LAUNCH_RERUNS, 2);
  const stuck = await attempt(timedOut);
  assert.deepEqual([stuck.code, stuck.runs, stuck.asked], [1, 1 + LAUNCH_RERUNS, [undefined, {afterLaunchTimeout: true}, {afterLaunchTimeout: true}]]);
  assert.deepEqual(stuck.lists, [["fake.test.mjs"], [file], [file]], "only the file whose launch timed out runs again");
  assert.match(stuck.text, /^integration +failed +3\.0 s, after 2 min waiting for the render slot, retrying a Chrome launch 3×, running a file again after a Chrome launch timed out 2×$/m);
  assert.ok(stuck.text.includes(`integration: Chrome's launch timed out twice in ${file} again; not run again after 2 waits for the machine.`), stuck.text);
  assert.match(stuck.text, /^web:browser +not run +after integration failed$/m);

  // The launch removes the profile of a Chrome it killed (#52): one left behind fails the suite like any other leftover.
  for (const [why, outcome] of [["a launch profile left", {...timedOut, left: ["playwright_chromiumdev_profile-Ad6i5f"]}], ["launch artifacts left", {...timedOut, left: ["playwright-artifacts-Q1w2e3"]}], ["another failure", {...timedOut, launchTimeouts: []}], ["another leftover", {...timedOut, left: ["xcrun_db"]}], ["no retried launch", {...timedOut, launchRetries: []}], ["a passing suite", {...timedOut, code: 0}]]) {
    const once = await attempt(outcome);
    assert.deepEqual([once.runs, once.asked.length], [outcome.code ? 1 : 2, outcome.code ? 1 : 2], why);
    assert.doesNotMatch(once.text, /running a file again/, why);
  }
  const unit = await attempt(timedOut, {unit: {}});
  assert.deepEqual([unit.runs, unit.asked], [1, []], "a suite without Chrome asks no gate");
});

// 2026-11-21 (#48): a test that skips NOT COVERED showed only in the reporter's stream; the summary spoke of suites alone.
test("a suite's log lists each test skipped NOT COVERED, a nested one too, with its reason; a skip with another reason is not listed", {timeout: 60_000}, async (t) => {
  const log = await logFile(t);
  const {code, notCovered} = await execute("not-covered", {flags: []}, ["tests/fixtures/runner/not-covered.test.mjs"], log, {echo: false});
  assert.equal(code, 0, await readFile(log, "utf8"));
  assert.deepEqual(notCovered, [
    {test: "a skip that names its command", reason: "ffmpeg is missing; run brew install ffmpeg (x) --write"},
    {test: "an options skip", reason: "the option's reason"},
    {test: "a nested skip", reason: "the nested reason"}
  ]);
});

test("a test skipped NOT COVERED gets a summary line with its suite and reason, once across a run again of its file, a failed suite's too, and fails no run", async () => {
  const file = "tests/integration/session-update.test.mjs";
  const first = {test: "first", reason: "run a --write"};
  const second = {test: "second", reason: "run b"};
  const summary = async (outcomes, suites) => {
    const lines = [];
    const code = await runSuites(Object.keys(suites), {
      suites,
      files: async () => ["fake.test.mjs"],
      gateFor: async () => ({ok: true, release: () => {}, waitedMs: 0, busy: "load 40.1 on 8 cores"}),
      run: async () => outcomes.shift(),
      newDirectory: async () => join(tmpdir(), "sws-runner-unused"),
      log: (line) => lines.push(line)
    });
    return {code, lines};
  };
  const passed = await summary([{code: 0, seconds: 1, notCovered: [first]}], {unit: {}});
  assert.equal(passed.code, 0, "a skipped test fails no run");
  assert.deepEqual(passed.lines.filter((line) => line.includes("NOT COVERED")), ["NOT COVERED in unit: first # run a --write"]);

  // The #46 loop: the file runs again after its launch timed out, skips the same test again, and one more.
  const third = {test: "third", reason: "run c"};
  const timedOut = {code: 1, seconds: 1, launchRetries: ["Chrome launch retried: why"], launchTimeouts: [file], left: [], notCovered: [first, second]};
  const again = await summary([timedOut, {code: 0, seconds: 1, notCovered: [first, third]}], {"web:browser": {browser: true}});
  assert.equal(again.code, 0);
  assert.deepEqual(again.lines.filter((line) => line.includes("NOT COVERED")), ["NOT COVERED in web:browser: first # run a --write", "NOT COVERED in web:browser: second # run b", "NOT COVERED in web:browser: third # run c"]);

  const failed = await summary([{code: 1, seconds: 1, notCovered: [second]}], {unit: {}, web: {}});
  assert.equal(failed.code, 1);
  assert.ok(failed.lines.includes("NOT COVERED in unit: second # run b"), failed.lines.join("\n"));
  assert.ok(failed.lines.indexOf("NOT COVERED in unit: second # run b") > failed.lines.findIndex((line) => /^unit +failed/.test(line)), "the line comes after the suites'");
});

test("with the vault source of the render slot changed after its last sync, the summary names the sync command once, and the gate copies that line under npm test and exits 3", {timeout: 90_000}, async (t) => {
  const home = await mkdtemp(join(tmpdir(), "sws-runner-home-"));
  t.after(() => rm(home, {recursive: true, force: true}));
  // The source is the copy plus a line, so the copy still matches the sha256 its last sync recorded.
  await mkdir(join(home, "obsidian", "AI", "scripts"), {recursive: true});
  const copy = await readFile(fileURLToPath(new URL("../../src/shared/render-slot.ts", import.meta.url)), "utf8");
  await writeFile(join(home, "obsidian", "AI", "scripts", "render-slot.ts"), `${copy}// changed\n`);
  const name = "src/shared/render-slot.ts is the vault source byte for byte, or the copy its last sync recorded";
  const lines = [];
  const logs = [];
  const code = await runSuites(["unit"], {
    suites: {unit: {flags: [`--test-name-pattern=^${literal(name)}$`]}},
    files: async () => ["tests/unit/render-slot.test.mjs"],
    run: async (label, suite, list, logPath) => { logs.push(logPath); return execute(label, suite, list, logPath, {echo: false, environment: {...process.env, HOME: home}}); },
    newDirectory: async () => home,
    log: (line) => lines.push(line)
  });
  const command = "python3 ~/obsidian/AI/scripts/render_slot_copias.py --write --repo se-dev-kit";
  const naming = lines.filter((line) => line.includes(command));
  assert.deepEqual(naming, [`NOT COVERED in unit: ${name} # ~/obsidian/AI/scripts/render-slot.ts changed after the last sync, which src/shared/render-slot.ts still matches; run ${command}`]);
  assert.equal(code, 0);

  // npm test echoes the reporter's stream before its summary.
  const output = `${await readFile(logs[0], "utf8")}\n${lines.join("\n")}\n`;
  assert.ok(output.includes(`﹣ ${name}`), "the reporter's own skip line is in npm test's output");
  const root = join(home, "checkout");
  await mkdir(root);
  const git = (...args) => execFileSync("git", ["-c", "user.name=Runner Test", "-c", "user.email=runner@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {cwd: root, stdio: "ignore"});
  git("init", "-q", "-b", "main");
  await writeFile(join(root, ".gitignore"), ".cache/\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const shown = [];
  const exit = await runGate({root, run: async (step) => ({code: 0, output: step.name === "npm test" ? output : ""}), log: (line) => shown.push(line), error: (line) => shown.push(line), stopped: () => undefined});
  assert.equal(exit, EXIT.notCovered);
  const under = shown.findIndex((line) => line.startsWith("npm test "));
  assert.equal(shown[under + 1], `  ${naming[0]}`);
  assert.equal(shown.filter((line) => line.includes(command)).length, 1, shown.join("\n"));
  assert.deepEqual(notCoveredSuites(naming), []);
  assert.doesNotMatch(shown.at(-1), /test:browser/);
});

test("a log's files to run again are those whose failing tests all ended in a launch timeout, as the reporter printed it on 2026-11-20", () => {
  const timeout = "test at tests/integration/jquery-recents.test.mjs:32:1\n✖ the widget frame loads jQuery 3.3.1 before the widget's HTML scripts (84490.536958ms)\n  Error [StudioError]: Chrome did not start within 30 s (/Applications/Google Chrome.app/Contents/MacOS/Google Chrome).\n      at launchTimeout (file:///x/dist/capture/browser.js:124:33)\n      at async TestContext.<anonymous> (file:///x/tests/integration/jquery-recents.test.mjs:54:21) {\n    code: 'BROWSER_LAUNCH_TIMEOUT',\n    hint: 'The machine may be busy with another render: check for running headless Chrome, wait, and retry. The process this launch started was killed.'\n  }\n\nintegration left 1 entry in its temporary folder: playwright_chromiumdev_profile-Ad6i5f\n";
  const other = "test at tests/integration/browser-lifecycle.test.mjs:89:1\n✖ a launched Chrome runs a transition on the main thread (5677.349125ms)\n  AssertionError [ERR_ASSERTION]: Chrome drew 3 frames of a transition while the main thread was blocked\n      at TestContext.<anonymous> (file:///x/tests/integration/browser-lifecycle.test.mjs:123:10) {\n    generatedMessage: false,\n    code: 'ERR_ASSERTION',\n  }\n\n";
  const log = (...blocks) => `✔ other (1.2ms)\n\n✖ failing tests:\n\n${blocks.join("")}`;
  assert.deepEqual(launchTimeoutFiles(log(timeout)), ["tests/integration/jquery-recents.test.mjs"]);
  assert.deepEqual(launchTimeoutFiles(log(timeout, timeout.replace(":32:1", ":90:1"))), ["tests/integration/jquery-recents.test.mjs"], "a file once");
  assert.deepEqual(launchTimeoutFiles(log(other, timeout)), [], "that run also had other failures");
  assert.deepEqual(launchTimeoutFiles(`    code: 'BROWSER_LAUNCH_TIMEOUT',\n${log(other)}`), [], "a timeout outside the failing list is none");
  assert.deepEqual(launchTimeoutFiles(`${other}${log(timeout)}`), ["tests/integration/jquery-recents.test.mjs"], "a failure above the failing list is not in it");
  assert.deepEqual(launchTimeoutFiles("✔ all passed\n"), []);
});

test("the history counts each test's failures across runs, the most frequent first, and survives a line cut short", () => {
  const failed = (test, error) => ({file: "a.test.mjs", test, error});
  const report = historyReport([
    {at: "2026-11-04T10:00:00.000Z", suite: "integration", status: "failed", failures: [failed("rare", "first"), failed("often", "old error")]},
    {at: "2026-11-05T10:00:00.000Z", suite: "integration", status: "failed", failures: [failed("often", "new error")]}
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n{\"at\": \"2026-11-05T1", "history");
  assert.deepEqual(report.split("\n"), [
    "history: 2 suite run(s) from 2026-11-04 to 2026-11-05.",
    "integration: 2 run(s), 0 passed, 2 failed, 0 skipped",
    "  2× a.test.mjs: often; last on 2026-11-05: new error",
    "  1× a.test.mjs: rare; last on 2026-11-04: first"
  ]);
  assert.equal(historyReport("", "history"), "history holds no runs yet.");
});

test("every checkout of a repository, a worktree or the main one, writes one history in the main checkout's .cache", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "sws-history-repo-"));
  t.after(() => rm(directory, {recursive: true, force: true}));
  // A realpath, as git prints one: macOS's temporary folder is a link.
  const main = join(await realpath(directory), "main");
  const git = (...args) => execFileSync("git", args, {cwd: main, stdio: "ignore", env: {...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com"}});
  await mkdir(main);
  git("init", "-q");
  git("commit", "-q", "--allow-empty", "-m", "first");
  const worktree = join(main, ".claude", "worktrees", "task");
  git("worktree", "add", "-q", "-b", "wip/task", worktree);
  const expected = join(main, ".cache", "test-history.jsonl");
  assert.equal(historyFile(main, {}), expected);
  assert.equal(historyFile(worktree, {}), expected);
  assert.equal(historyFile(worktree, {TEST_HISTORY_FILE: "/elsewhere/h.jsonl"}), "/elsewhere/h.jsonl");
  const outside = join(await realpath(directory), "not-a-repo");
  await mkdir(outside);
  assert.equal(historyFile(outside, {}), join(outside, ".cache", "test-history.jsonl"));
});
