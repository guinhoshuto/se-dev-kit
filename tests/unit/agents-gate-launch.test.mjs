import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

// Step 2 of a session on one issue said to run `npm run gate` "in the background": in Claude Code that is
// `run_in_background`, a shell that dies under critical memory pressure with nothing to report it, halfway through a
// gate whose build and browser suites wait in the render-slot queue (#40). The harness launches long steps through
// lancar_job.py since 2026-11-17: detached, with the Mac kept awake, in the job strip, and with an end line to wait for.
const agents = readFileSync(resolve(import.meta.dirname, "../../AGENTS.md"), "utf8");
const section = agents.split(/^## A session on one issue$/m)[1].split(/^## |^<!--/m)[0];
const step = section.split("\n").find((line) => line.startsWith("2. "));
const launch = step?.match(/`(PATH=[^`]*lancar_job\.py[^`]*)`/)?.[1];
const LAUNCHER = join(homedir(), "obsidian/AI/scripts/lancar_job.py");

test("AGENTS.md step 2 launches the gate through lancar_job.py, not a background shell", () => {
  assert.ok(step, "AGENTS.md has no step 2 in A session on one issue");
  assert.doesNotMatch(step, /in the background/);
  assert.ok(launch, "step 2 has no lancar_job.py command");
  assert.ok(launch.startsWith("PATH=/opt/homebrew/opt/node@24/bin:$PATH python3 ~/obsidian/AI/scripts/lancar_job.py "), "the detached gate does not run on Node 24");
  assert.ok(launch.endsWith(" -- npm run gate"), "the launched command is not npm run gate");
  const options = launch.slice(0, launch.lastIndexOf(" -- "));
  for (const option of ["--tarefa gate-<task>", "--log ", "--cwd "]) assert.ok(options.includes(option), `the launch has no ${option.trim()}`);
  const log = options.match(/--log (.+?) --/)[1];
  assert.ok(log.includes("$(date +"), "the launch log is not new at each launch, so an earlier end line ends the wait at once");
  assert.ok(!log.startsWith(".cache/gate/<commit>/"), "the launch log is inside the folder whose logs the gate clears");
});

test("AGENTS.md step 2 waits for the end line lancar_job.py prints, in one background Bash", () => {
  assert.ok(step.includes("`o fim: grep -qE '<end line>' <log>`"), "step 2 does not quote the end line's check");
  assert.ok(step.includes("`run_in_background: true` (`until <that grep>; do sleep 60; done`)"), "step 2 does not say how to wait for the end line");
  assert.ok(step.includes("The end line's `rc=` is the gate's exit code."), "step 2 does not say what the end line carries");
});

// On 2026-11-18 a gate failed at a Chrome launch that timed out twice as the load rose, and step 2 said «No step waits for
// the machine check», so the session put a hand-written machine wait in front of npm run gate, the chain #38 removed. The
// runner waits for that check before each browser suite, and since #46 again after such a launch.
test("AGENTS.md says the gate's runner waits for the machine check, so nothing goes in front of npm run gate", () => {
  assert.doesNotMatch(step, /No step waits for the machine check/);
  assert.ok(step.includes("Nothing goes in front of `npm run gate`: its runner already waits for the machine check before each browser suite, and again after a Chrome launch that runs out of its 30 s twice"), "step 2 does not say the runner waits for the machine check");
  const tests = agents.split("\n").find((line) => line.startsWith("- `npm test` runs"));
  assert.ok(tests?.includes("When that second launch runs out too, the runner asks the machine check again: told to wait, it gives the render slot back, waits as it does before a browser suite, and runs that test file again, at most twice, its summary and the history naming the wait; told the machine is free, the suite fails."), "the npm test paragraph does not say what a launch that times out twice does");
  const gate = readFileSync(resolve(import.meta.dirname, "../../scripts/gate.mjs"), "utf8");
  assert.doesNotMatch(gate, /No step (waits for|runs or polls) the machine check/, "scripts/gate.mjs still says nothing waits for the machine check");
  assert.match(gate, /^Nothing goes in front of the gate: npm test waits for the machine check before each browser suite/m, "the gate's help does not say npm test waits for the machine check");
});

test("the launch in AGENTS.md step 2 is one lancar_job.py accepts, and it prints the end line's check", async (t) => {
  if (!existsSync(LAUNCHER)) return t.skip("no vault on this machine");
  assert.ok(readFileSync(LAUNCHER, "utf8").includes('print(f"o fim: grep -qE '), "lancar_job.py no longer prints the end line's check that step 2 quotes");
  const cwd = await mkdtemp(join(tmpdir(), "sws-gate-launch-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  // --seco says what it would launch and writes nothing; the placeholder becomes a task name zsh can parse.
  const line = launch.replaceAll("<task>", "test-task").replace(" -- npm run gate", " --seco -- npm run gate");
  const run = spawnSync("/bin/zsh", ["-f", "-c", line], { cwd, encoding: "utf8", env: { ...process.env, PWD: cwd } });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /\bgate-test-task · npm run gate\b/);
  const logs = [cwd, realpathSync(cwd)].map((folder) => `log ${folder}/.cache/gate/launch-`);
  assert.ok(logs.some((log) => run.stdout.includes(log)), `the log does not resolve inside --cwd: ${run.stdout}`);
});
