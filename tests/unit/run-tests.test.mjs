import assert from "node:assert/strict";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

import {SUITES, execute, leftovers, nodeArgs, suiteForFile} from "../../scripts/run-tests.mjs";

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

test("a test that never settles, in a file whose event loop never empties, ends at its timeout", {timeout: 60_000}, async (t) => {
  const log = await logFile(t);
  const started = Date.now();
  const {code} = await execute("hung", {flags: ["--test-timeout=700"]}, ["tests/fixtures/runner/hung.test.mjs"], log, {echo: false});
  assert.equal(code, 1);
  assert.ok(Date.now() - started < 30_000, `the hung file ended after ${Date.now() - started} ms`);
  assert.match(await readFile(log, "utf8"), /never settles/);
});
