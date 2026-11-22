import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {existsSync, readFileSync} from "node:fs";
import {mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join, resolve} from "node:path";
import test from "node:test";
import {EXIT, UsageError, changedPlans, dryRun, gateBase, gitState, notCoveredSuites, parseArgs, runGate} from "../../scripts/gate.mjs";

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

// 2026-11-21 (#48): a test skipped NOT COVERED reached neither the runner's summary nor the gate.
test("a test npm test skipped NOT COVERED is copied under npm test once, apart from the suites, and the gate exits 3 with a sentence of its own", async t => {
  const {root, commit} = await checkout(t);
  const suiteLine = "NOT COVERED: integration. This run did not test them; run npm run test:browser, which waits its turn in the render slot queue.";
  const testLine = "NOT COVERED in web:browser: the copy test # the source changed; run sync --write";
  // npm test echoes the reporter's stream, whose skip line also holds NOT COVERED, before its summary.
  const echoed = "  ﹣ the copy test (0.4ms) # NOT COVERED: the source changed; run sync --write";
  const both = await gate(root, fake({outputs: {"npm test": `${echoed}\nweb:browser  passed   1.0 s\n${suiteLine}\n${testLine}\nLogs: .cache/test-logs/run-3/\n`}}));
  assert.equal(both.code, EXIT.notCovered);
  const under = both.lines.findIndex(line => line.startsWith("npm test "));
  assert.deepEqual(both.lines.slice(under + 1, under + 3), [`  ${suiteLine}`, `  ${testLine}`]);
  assert.equal(both.lines.filter(line => line.includes("NOT COVERED")).length, 3, both.lines.join("\n"));
  assert.deepEqual(notCoveredSuites([suiteLine, testLine]), ["integration"]);
  assert.equal(both.last, `gate ${commit} passed, but npm test left NOT COVERED: integration. Run npm run test:browser again, or name them in the question. npm test also skipped 1 test(s) NOT COVERED, listed under it with what to run: do what each says, or name it in the question.`);

  const {root: other, commit: otherCommit} = await checkout(t);
  const tests = await gate(other, fake({outputs: {"npm test": `${echoed}\n${testLine}\nNOT COVERED in unit: another # run x\nLogs: .cache/test-logs/run-4/\n`}}));
  assert.equal(tests.code, EXIT.notCovered);
  assert.equal(tests.last, `gate ${otherCommit} passed, but npm test skipped 2 test(s) NOT COVERED, listed under it with what to run: do what each says, or name it in the question.`);
  assert.doesNotMatch(tests.last, /test:browser/, "npm run test:browser runs suites, not a skipped test's step");
});

test("without origin/main, the plans against main are the tests/ plans the branch adds or changes since the merge base, without deleted ones", async t => {
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

// #49: the base was the short name main, the local main every worktree shares with the live checkout. With that main
// behind origin/main, the gate also ran the plans of commits already on origin (etsy-thumb-generator#18: two plans of
// 2 and 9 min for a one-line docs commit). The base is now origin/main by its whole ref name, else the local main.
const ORIGIN_MAIN = "refs/remotes/origin/main";
const LOCAL_MAIN = "refs/heads/main";
const commitAll = (root, message) => {git(root, "add", "-A"); git(root, "commit", "-q", "-m", message);};
const dry = root => {const lines = []; const code = dryRun({root, log: line => lines.push(line)}); return {code, text: lines.join("\n")};};
const BASE_STEPS = ["typecheck", "npm test", "build", "verify:bundle"];

/**
 * A checkout whose origin/main (a remote-tracking ref written by hand, with no remote) is one commit ahead of the local
 * main with a plan of its own (o), and whose branch wip/y, born from origin/main, adds one plan (y).
 */
async function behind(t) {
  const root = await folder(t);
  git(root, "init", "-q", "-b", "main");
  await put(root, {".gitignore": ".cache/\n", "x.mjs": "a\n"});
  commitAll(root, "base");
  git(root, "checkout", "-q", "-b", "wip/y");
  await put(root, {"tests/unit/o.mutations.json": plan("tests/unit/o.test.mjs")});
  commitAll(root, "on origin/main, not on the local main");
  git(root, "update-ref", ORIGIN_MAIN, "HEAD");
  await put(root, {"tests/unit/y.mutations.json": plan("tests/unit/y.test.mjs")});
  commitAll(root, "the branch's plan");
  return root;
}

test("with the local main behind origin/main, the gate runs only the plans the branch changes against origin/main", async t => {
  const root = await behind(t);
  const short = git(root, "rev-parse", "--short", ORIGIN_MAIN);
  assert.deepEqual(gateBase({root}), {name: "origin/main", sha: git(root, "rev-parse", ORIGIN_MAIN), short});
  assert.deepEqual(changedPlans({root}), ["tests/unit/y.mutations.json"]);
  const runner = fake();
  assert.equal((await gate(root, runner)).code, EXIT.passed);
  assert.deepEqual(runner.seen.map(step => step.name), [...BASE_STEPS, "mutate tests/unit/y.mutations.json"], "a plan already on origin/main ran");
  const {code, text} = dry(root);
  assert.equal(code, EXIT.passed);
  assert.ok(text.includes(`Base: origin/main (${short})`), text);
  assert.ok(text.includes("Mutation plans added or changed against origin/main: tests/unit/y.mutations.json"), text);
  // On origin/main itself the branch changes no plan, and the summary names the base it compared with.
  git(root, "checkout", "-q", "--detach", ORIGIN_MAIN);
  const none = await gate(root, fake());
  assert.equal(none.code, EXIT.passed);
  assert.ok(none.lines.some(line => /^mutation plans +none +no tests\/\*\*\/\*\.mutations\.json added or changed against origin\/main \(\w+\)$/.test(line) && line.endsWith(`(${short})`)), none.lines.join("\n"));
});

test("a local branch called origin/main and a tag called main are not taken as the base", async t => {
  // Beside the remote ref, a local branch origin/main (at the local main, behind): `git rev-parse origin/main` takes the branch.
  const both = await behind(t);
  git(both, "branch", "origin/main", LOCAL_MAIN);
  assert.notEqual(git(both, "rev-parse", "refs/heads/origin/main"), git(both, "rev-parse", ORIGIN_MAIN));
  assert.equal(gateBase({root: both}).sha, git(both, "rev-parse", ORIGIN_MAIN));
  assert.deepEqual(changedPlans({root: both}), ["tests/unit/y.mutations.json"]);
  assert.ok(dry(both).text.includes(`Base: origin/main (${git(both, "rev-parse", "--short", ORIGIN_MAIN)})`));
  // Without the remote ref, a local branch called origin/main (at the branch's tip) does not pass for it.
  const {root: alone} = await checkout(t);
  git(alone, "branch", "origin/main", "HEAD");
  assert.deepEqual(gateBase({root: alone}), {name: "main", sha: git(alone, "rev-parse", LOCAL_MAIN), short: git(alone, "rev-parse", "--short", LOCAL_MAIN)});
  assert.deepEqual(changedPlans({root: alone}), ["tests/unit/a.mutations.json", "tests/unit/b.mutations.json"]);
  // A tag called main (at the branch's tip): `git rev-parse main` takes the tag before the branch.
  const {root: tagged} = await checkout(t);
  git(tagged, "tag", "main", "HEAD");
  assert.deepEqual(gateBase({root: tagged}), {name: "main", sha: git(tagged, "rev-parse", LOCAL_MAIN), short: git(tagged, "rev-parse", "--short", LOCAL_MAIN)});
  const runner = fake();
  assert.equal((await gate(tagged, runner)).code, EXIT.passed);
  assert.deepEqual(runner.seen.map(step => step.name), STEPS);
});

test("an origin/main with no merge base with HEAD is refused with exit 2, runs nothing, and never falls back to main", async t => {
  const {root, commit} = await checkout(t);
  git(root, "update-ref", ORIGIN_MAIN, git(root, "commit-tree", "-m", "an unrelated history", "HEAD^{tree}"));
  const runner = fake();
  const {code, errors} = await gate(root, runner);
  assert.equal(code, EXIT.usage);
  assert.deepEqual(runner.seen, []);
  assert.match(errors.join("\n"), new RegExp(`^gate ${commit} refused: Cannot diff against origin/main \\(\\w+\\): .*no merge base.*git fetch`));
  assert.throws(() => changedPlans({root}), UsageError);
  assert.throws(() => dryRun({root, log: () => {}}), UsageError);
  assert.equal(existsSync(join(root, ".cache")), false, "a refused run wrote its log folder");
});

test("with neither origin/main nor main the gate is refused with exit 2 and runs nothing", async t => {
  const {root, commit} = await checkout(t);
  git(root, "branch", "-m", "main", "trunk");
  const runner = fake();
  const {code, errors} = await gate(root, runner);
  assert.equal(code, EXIT.usage);
  assert.deepEqual(runner.seen, []);
  assert.match(errors.join("\n"), new RegExp(`^gate ${commit} refused: There is no main .*neither refs/remotes/origin/main nor refs/heads/main.*git fetch first\\.$`));
  assert.throws(() => gateBase({root}), UsageError);
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
  assert.ok(step.includes("each step's log in `.cache/gate/<commit>/`"), "step 2 does not say where the logs go");
  assert.ok(step.includes("against `origin/main` as of the last fetch, or the local `main` without that ref"), "step 2 does not say the plans' base");
  assert.ok(step.includes("The gate does not fetch: `git fetch` first."), "step 2 does not say to fetch first");
  const {scripts} = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
  assert.equal(scripts.gate, "node scripts/gate.mjs");
});
