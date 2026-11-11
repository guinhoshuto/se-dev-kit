import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {existsSync, readFileSync} from "node:fs";
import {mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join, resolve} from "node:path";
import test from "node:test";
import {EXIT, UsageError, changedPlans, dryRun, gitState, parseArgs, runGate} from "../../scripts/gate.mjs";

// npm run gate is the gate of a session on one issue (AGENTS.md step 2). Sessions wrote their own zsh chains, which
// waited on `maquina_livre.py --esperar` before npm run build while the render-slot queue moved (86 min before each
// build, #38); the gate puts the build in that queue and runs the steps in their order, stopping at the first failure.
const SLOT = "dist/shared/render-slot.js";
const GIT = ["-c", "user.name=Gate Test", "-c", "user.email=gate@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];

async function folder(t) {
  const path = await mkdtemp(join(tmpdir(), `sws-gate-${process.pid}-`));
  t.after(() => rm(path, {recursive: true, force: true}));
  return path;
}

const git = (root, ...args) => execFileSync("git", [...GIT, ...args], {cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]}).trim();

async function put(root, files) {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), {recursive: true});
    await writeFile(join(root, path), text);
  }
}

const plan = test => JSON.stringify({mutations: [{file: "x.mjs", from: "a", to: "b", test}]});

/** A checkout on wip/x whose branch adds a unit plan (a) and a plan with a Chrome test (b), and ignores .cache/. */
async function checkout(t) {
  const root = await folder(t);
  git(root, "init", "-q", "-b", "main");
  await put(root, {".gitignore": ".cache/\n", "x.mjs": "a\n"});
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  git(root, "checkout", "-q", "-b", "wip/x");
  await put(root, {"tests/unit/a.mutations.json": plan("tests/unit/a.test.mjs"), "tests/unit/b.mutations.json": plan("tests/integration/b.test.mjs")});
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "plans");
  return {root, commit: git(root, "rev-parse", "--short", "HEAD")};
}

/** A step runner that records each step, writes `outputs[name]` to its log, and exits with `codes[name]` (default 0). */
function fake({outputs = {}, codes = {}, during = {}} = {}) {
  const seen = [];
  const run = async (step, {logPath}) => {
    seen.push({name: step.name, command: step.command, args: step.args, logPath});
    await writeFile(logPath, outputs[step.name] ?? "");
    await during[step.name]?.();
    return {code: codes[step.name] ?? 0, output: outputs[step.name] ?? ""};
  };
  return {run, seen};
}

async function gate(root, runner) {
  const lines = []; const errors = [];
  const code = await runGate({root, run: runner.run, log: line => lines.push(line), error: line => errors.push(line), stopped: () => undefined});
  return {code, lines, errors, last: lines.at(-1)};
}

const STEPS = ["typecheck", "npm test", "build", "verify:bundle", "mutate tests/unit/a.mutations.json", "mutate tests/unit/b.mutations.json"];

test("the gate runs typecheck, npm test, the build in the render-slot queue, verify:bundle, then each changed plan", async t => {
  const {root, commit} = await checkout(t);
  const runner = fake({outputs: {
    "npm test": "Test logs: .cache/test-logs/run-1/\nLogs: .cache/test-logs/run-1/\n",
    "mutate tests/unit/a.mutations.json": "KILLED x.mjs\n1 of 1 mutation(s) killed.\n"
  }});
  const {code, lines, last} = await gate(root, runner);
  assert.equal(code, EXIT.passed);
  assert.deepEqual(runner.seen.map(step => step.name), STEPS);
  const [typecheck, npmTest, build, verify, unitPlan, chromePlan] = runner.seen;
  assert.deepEqual([typecheck.command, ...typecheck.args], ["npm", "run", "typecheck"]);
  assert.deepEqual([npmTest.command, ...npmTest.args], ["npm", "test"]);
  assert.deepEqual([build.command, ...build.args], ["node", SLOT, "run", "--repo", root, "--", "npm", "run", "build"]);
  assert.deepEqual([verify.command, ...verify.args], ["npm", "run", "verify:bundle"]);
  assert.deepEqual([unitPlan.command, ...unitPlan.args], ["node", "scripts/mutate.mjs", "--plan", "tests/unit/a.mutations.json"], "a unit plan runs without the render slot");
  assert.deepEqual([chromePlan.command, ...chromePlan.args], ["node", SLOT, "run", "--", "node", "scripts/mutate.mjs", "--plan", "tests/unit/b.mutations.json"], "a plan whose test starts Chrome waits in the render-slot queue");
  const directory = join(root, ".cache", "gate", commit);
  for (const step of runner.seen) assert.equal(dirname(step.logPath), directory, `${step.name} logs outside .cache/gate/<commit>/`);
  assert.equal(last, `gate ${commit} passed: 6 step(s).`);
  assert.match(lines[0], new RegExp(`^\\d\\d:\\d\\d:\\d\\d gate ${commit} · typecheck …$`), "no progress line at the step's start");
  assert.match(lines.find(line => line.startsWith("npm test ")), /passed .* \.cache\/gate\/\w+\/npm-test\.log Logs: \.cache\/test-logs\/run-1\/$/);
  assert.match(lines.find(line => line.startsWith("mutate tests/unit/a.mutations.json ")), / 1 of 1 mutation\(s\) killed\.$/);
  const summary = await readFile(join(directory, "summary.txt"), "utf8");
  assert.ok(summary.endsWith(`${last}\n`), "summary.txt does not hold the summary");
});

test("the gate stops at the first failed step, names it with its log, and leaves the rest not run", async t => {
  const {root, commit} = await checkout(t);
  const runner = fake({codes: {build: 2}});
  const {code, lines, last} = await gate(root, runner);
  assert.equal(code, EXIT.failed);
  assert.deepEqual(runner.seen.map(step => step.name), ["typecheck", "npm test", "build"]);
  assert.equal(last, `gate ${commit} FAILED at build: .cache/gate/${commit}/build.log`);
  assert.match(lines.find(line => line.startsWith("verify:bundle ")), /^verify:bundle +not run$/);
});

test("a NOT COVERED left by npm test is copied under its line, the other steps still run, and the gate exits 3", async t => {
  const {root, commit} = await checkout(t);
  const notCovered = "NOT COVERED: integration, web:browser. This run did not test them; run npm run test:browser, which waits its turn in the render slot queue.";
  const runner = fake({outputs: {"npm test": `Skipped integration: busy\n${notCovered}\nLogs: .cache/test-logs/run-2/\n`}});
  const {code, lines, last} = await gate(root, runner);
  assert.equal(code, EXIT.notCovered);
  assert.deepEqual(runner.seen.map(step => step.name), STEPS);
  assert.equal(lines[lines.findIndex(line => line.startsWith("npm test ")) + 1], `  ${notCovered}`);
  assert.equal(last, `gate ${commit} passed, but npm test left NOT COVERED: integration, web:browser. Run npm run test:browser again, or name them in the question.`);
});

test("the plans against main are the tests/ plans the branch adds or changes since the merge base, without deleted ones", async t => {
  const root = await folder(t);
  git(root, "init", "-q", "-b", "main");
  // Each plan has text of its own: git would read a deleted plan and an added one with the same text as a rename.
  await put(root, {"tests/unit/b.mutations.json": "[\"b\"]", "tests/unit/c.mutations.json": "[\"c\"]", "tests/unit/m.mutations.json": "[\"m\"]"});
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  git(root, "checkout", "-q", "-b", "wip/x");
  await put(root, {"tests/unit/a.mutations.json": "[\"a, new on the branch\"]", "tests/unit/b.mutations.json": "[\"b, changed on the branch\"]", "scripts/y.mutations.json": "[\"y\"]", "tests/unit/x.test.mjs": "// x\n"});
  await rm(join(root, "tests/unit/c.mutations.json"));
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "branch");
  git(root, "checkout", "-q", "main");
  // main moves ahead: a plan it changes, and one it adds, are not the branch's.
  await put(root, {"tests/unit/m.mutations.json": "[\"m, changed on main\"]", "tests/unit/n.mutations.json": "[\"n, new on main\"]"});
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "ahead");
  git(root, "checkout", "-q", "wip/x");
  assert.deepEqual(changedPlans({root}), ["tests/unit/a.mutations.json", "tests/unit/b.mutations.json"]);
});

test("a dirty tree is refused before any step, with its entries", async t => {
  const {root, commit} = await checkout(t);
  await writeFile(join(root, "notes.txt"), "draft\n");
  const runner = fake();
  const {code, errors} = await gate(root, runner);
  assert.equal(code, EXIT.usage);
  assert.deepEqual(runner.seen, []);
  assert.match(errors.join("\n"), new RegExp(`gate ${commit} refused: .*commit first\\.\\n  \\?\\? notes\\.txt`));
  assert.equal(existsSync(join(root, ".cache")), false, "a refused run wrote its log folder");
});

test("a step after which the tree changed fails the gate there", async t => {
  const {root, commit} = await checkout(t);
  const runner = fake({during: {typecheck: () => writeFile(join(root, "x.mjs"), "changed\n")}});
  const {code, lines, last} = await gate(root, runner);
  assert.equal(code, EXIT.failed);
  assert.deepEqual(runner.seen.map(step => step.name), ["typecheck"]);
  assert.match(lines.find(line => line.startsWith("typecheck ")), /the tree changed during the gate$/);
  assert.equal(last, `gate ${commit} FAILED at typecheck: .cache/gate/${commit}/typecheck.log`);
});

test("a run removes only the *.log files and summary.txt an earlier run of the commit left, never recursively", async t => {
  const {root, commit} = await checkout(t);
  const directory = join(root, ".cache", "gate", commit);
  await put(root, {[`.cache/gate/${commit}/old.log`]: "old", [`.cache/gate/${commit}/keep.txt`]: "keep", [`.cache/gate/${commit}/nested.log/inner.log`]: "inner"});
  assert.equal((await gate(root, fake())).code, EXIT.passed);
  assert.equal(existsSync(join(directory, "old.log")), false);
  assert.equal(await readFile(join(directory, "keep.txt"), "utf8"), "keep");
  assert.equal(await readFile(join(directory, "nested.log", "inner.log"), "utf8"), "inner");
});

test("--dry-run prints the steps and plans, says a dirty tree would be refused, and writes nothing", async t => {
  const {root, commit} = await checkout(t);
  await writeFile(join(root, "notes.txt"), "draft\n");
  const lines = [];
  assert.equal(dryRun({root, log: line => lines.push(line)}), EXIT.passed);
  const text = lines.join("\n");
  assert.match(text, new RegExp(`^gate ${commit} \\(dry run`));
  assert.ok(text.includes(`node ${SLOT} run --repo ${root} -- npm run build`), "the build's command is missing");
  assert.ok(text.includes("tests/unit/a.mutations.json, tests/unit/b.mutations.json"), "the plans are missing");
  assert.match(text, /the real run would refuse \(exit 2\).*\n  \?\? notes\.txt/);
  assert.equal(existsSync(join(root, ".cache")), false);
  assert.throws(() => parseArgs(["--force"]), UsageError);
  assert.deepEqual(parseArgs(["--dry-run"]), {dryRun: true, help: false});
});

test("outside a git checkout the gate refuses", async t => {
  const root = await folder(t);
  assert.throws(() => gitState(root), UsageError);
});

test("AGENTS.md step 2 of a session on one issue names npm run gate, and package.json has the gate script", () => {
  const repo = resolve(import.meta.dirname, "../..");
  const agents = readFileSync(join(repo, "AGENTS.md"), "utf8");
  const section = agents.split(/^## A session on one issue$/m)[1].split(/^## |^<!--/m)[0];
  const step = section.split("\n").find(line => line.startsWith("2. "));
  assert.ok(step?.includes("`npm run gate`"), "step 2 does not name npm run gate");
  assert.ok(step.includes("`.cache/gate/<commit>/`"), "step 2 does not say where the logs go");
  const {scripts} = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
  assert.equal(scripts.gate, "node scripts/gate.mjs");
});
