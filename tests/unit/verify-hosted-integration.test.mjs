import assert from "node:assert/strict";
import {mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import test from "node:test";

import {SUITES, nodeArgs} from "../../scripts/run-tests.mjs";
import {
  SANDBOX_ROOT,
  integrationCommand,
  integrationSummary,
  integrationUploads,
  oidcClaims,
  parseOptions,
  verifyIntegration
} from "../../scripts/verify-hosted.mjs";

const IDS = ["--snapshot-id", "snap_1", "--expected-team-id", "team_1", "--expected-project-id", "prj_1"];
const PASSING = "✔ same href gives one load (12.5ms)\nℹ tests 2\nℹ suites 0\nℹ pass 2\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\n";
const sink = {write() {}};
const quiet = () => {};

function token(claims) {
  return ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "signature"].join(".");
}
const identity = {owner_id: "team_1", project_id: "prj_1", exp: Math.floor(Date.now() / 1000) + 3600};

async function fixtureRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "sws-sandbox-integration-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const files = {
    "package.json": '{"name":"se-widget-studio","type":"module"}\n',
    "package-lock.json": '{"lockfileVersion":3}\n',
    "dist/build-info.json": '{"version":"0.2.0","commit":"abc123","dirty":false}\n',
    "dist/runtime/frame.js": "export {};\n",
    "dist/.hidden.js": "not for the Sandbox\n",
    "presets/marketplace.json": "{}\n",
    "sample-media/manifest.json": "{}\n",
    "examples/basic-chat/widget.html": "<main></main>\n",
    "examples/basic-chat/.se-widget-studio/output/frame.png": "png\n",
    "tests/fixtures/fonts/Unbounded-400.woff2": "font\n",
    "tests/fixtures/.DS_Store": "finder\n",
    "tests/integration/font-readiness.test.mjs": "\n",
    "tests/integration/tutorial.test.mjs": "\n",
    "tests/integration/helper.mjs": "\n",
    "src/not-uploaded.ts": "\n"
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), {recursive: true});
    await writeFile(join(root, path), content);
  }
  return root;
}

/** A Sandbox API double that records what the verification asks of it. */
function fakeSandbox({testOutput = PASSING, exitCode = 0, leftovers = "", metadata = {}, outbound = "blocked", source = "snap_1"} = {}) {
  const calls = {create: [], writes: [], commands: [], stopped: 0};
  const sandbox = {
    sourceSnapshotId: source,
    async readFileToBuffer({path}) {
      if (path === `${SANDBOX_ROOT}/snapshot.json`) {
        return Buffer.from(JSON.stringify({createdAt: "2026-09-01T00:00:00.000Z", lockSha256: "other", networkPolicy: "deny-all", target: {teamId: "team_1", projectId: "prj_1"}, ...metadata}));
      }
      if (path === `${SANDBOX_ROOT}/browser/version.json`) return Buffer.from('{"playwright":"1.54.2","chromium":"139.0.7258.5"}');
      return null;
    },
    async writeFiles(files) {
      calls.writes.push(...files.map((file) => file.path));
    },
    async runCommand(params) {
      calls.commands.push(params);
      if (params.detached) {
        return {
          async *logs() {
            yield {stream: "stdout", data: testOutput};
          },
          async wait() {
            return {exitCode};
          }
        };
      }
      const stdout = params.args[0] === "--version" ? "v22.20.0" : params.cmd === "sh" ? leftovers : outbound;
      return {exitCode: 0, stdout: async () => stdout, stderr: async () => ""};
    },
    async stop() {
      calls.stopped += 1;
    }
  };
  return {
    calls,
    Sandbox: {
      async create(params) {
        calls.create.push(params);
        return sandbox;
      }
    }
  };
}

function run(fake, root, claims = identity) {
  const options = parseOptions(["--integration", "--allow-sandbox", ...IDS]);
  return verifyIntegration(options, {Sandbox: fake.Sandbox, env: {VERCEL_OIDC_TOKEN: token(claims)}, root, out: sink, log: quiet});
}

test("--integration needs --allow-sandbox and the three IDs, and takes no hosted API option", () => {
  const options = parseOptions(["--integration", "--allow-sandbox", ...IDS, "--test", "font-readiness.test.mjs"]);
  assert.equal(options.integration, true);
  assert.deepEqual(options.tests, ["font-readiness.test.mjs"]);
  assert.deepEqual([options.snapshotId, options.expectedTeamId, options.expectedProjectId], ["snap_1", "team_1", "prj_1"]);
  assert.throws(() => parseOptions(["--integration", ...IDS]), /--allow-sandbox/);
  assert.throws(() => parseOptions(["--integration", "--allow-sandbox", ...IDS.slice(0, 4)]), /--expected-project-id/);
  assert.throws(() => parseOptions(["--integration", "--allow-sandbox", ...IDS, "--base-url", "https://studio.example/"]), /calls no hosted API/);
  assert.throws(() => parseOptions(["--integration", "--allow-sandbox", ...IDS, "--fonts"]), /calls no hosted API/);
  assert.throws(() => parseOptions(["--integration", "--allow-sandbox", ...IDS, "--test", "../unit/init.test.mjs"]), /file name from tests\/integration/);
  assert.throws(() => parseOptions(["--integration", "--allow-sandbox", ...IDS, "--test", "a.test.mjs", "--test", "a.test.mjs"]), /only appear once/);
  assert.throws(() => parseOptions(["--base-url", "https://studio.example/", "--allow-hosted", "--allow-sandbox"]), /belong to --integration/);
  assert.throws(() => parseOptions(["--base-url", "https://studio.example/", "--allow-hosted", "--snapshot-id", "snap_1"]), /belong to --integration/);
});

test("the upload is package.json, the folders the tests read, and the selected tests, without dotfiles or links", async (t) => {
  const root = await fixtureRoot(t);
  const all = await integrationUploads([], root);
  assert.deepEqual(all.tests, ["font-readiness.test.mjs", "tutorial.test.mjs"]);
  assert.deepEqual(all.files, [
    "package.json",
    "dist/build-info.json",
    "dist/runtime/frame.js",
    "presets/marketplace.json",
    "sample-media/manifest.json",
    "examples/basic-chat/widget.html",
    "tests/fixtures/fonts/Unbounded-400.woff2",
    "tests/integration/font-readiness.test.mjs",
    "tests/integration/tutorial.test.mjs"
  ]);
  const one = await integrationUploads(["tutorial.test.mjs"], root);
  assert.deepEqual(one.files.filter((file) => file.startsWith("tests/integration/")), ["tests/integration/tutorial.test.mjs"]);
  await assert.rejects(integrationUploads(["missing.test.mjs"], root), /no tests\/integration\/missing\.test\.mjs/);
  await symlink(join(root, "package.json"), join(root, "dist", "linked.json"));
  await assert.rejects(integrationUploads([], root), /symbolic link: dist\/linked\.json/);
});

test("the Sandbox runs the integration suite's own arguments on the snapshot's browser, with its FFmpeg first on PATH", () => {
  const command = integrationCommand(["font-readiness.test.mjs"]);
  assert.equal(command.cmd, "sh");
  assert.equal(command.cwd, SANDBOX_ROOT);
  assert.equal(command.env.SE_WIDGET_STUDIO_BROWSER, `${SANDBOX_ROOT}/browser/chrome`);
  assert.match(command.env.TMPDIR, /^\/tmp\/./);
  assert.ok(command.args[1].includes(`export PATH="${SANDBOX_ROOT}/tools:$PATH"`), command.args[1]);
  assert.deepEqual(command.args.slice(3), nodeArgs(SUITES.integration, ["tests/integration/font-readiness.test.mjs"]));
  assert.ok(command.args.includes("--test-concurrency=1"));
});

test("a failed, cancelled, skipped, or empty run, or one without a summary, is a problem", () => {
  assert.deepEqual(integrationSummary(PASSING, 0).problems, []);
  assert.match(integrationSummary(PASSING.replace("ℹ skipped 0", "ℹ skipped 1"), 0).problems.join(), /1 skipped/);
  assert.match(integrationSummary(PASSING.replace("ℹ cancelled 0", "ℹ cancelled 1"), 0).problems.join(), /1 cancelled/);
  const failing = "✖ same href gives one load (12.5ms)\nℹ tests 2\nℹ pass 1\nℹ fail 1\nℹ cancelled 0\nℹ skipped 0\n✖ failing tests:\n\n✖ same href gives one load (12.5ms)\n";
  const failed = integrationSummary(failing, 1);
  assert.deepEqual(failed.failed, ["same href gives one load"]);
  assert.match(failed.problems.join(), /exited with 1/);
  assert.match(failed.problems.join(), /1 failed/);
  assert.match(integrationSummary("ℹ tests 0\nℹ pass 0\n", 0).problems.join(), /no test ran/);
  assert.match(integrationSummary("Error: Cannot find module\n", 1).problems.join(), /no test summary/);
});

test("the OIDC payload is read from the JWT's middle part", () => {
  assert.deepEqual(oidcClaims(token(identity)), identity);
  assert.throws(() => oidcClaims(undefined), /VERCEL_OIDC_TOKEN is required/);
  assert.throws(() => oidcClaims("not-a-jwt"), /not a JWT/);
});

test("a passing run clones the snapshot deny-all, uploads under the studio root, runs the suite detached, and stops the Sandbox", async (t) => {
  const root = await fixtureRoot(t);
  const fake = fakeSandbox();
  const report = await run(fake, root);
  assert.equal(report.status, "passed", report.error);
  assert.deepEqual(fake.calls.create, [{source: {type: "snapshot", snapshotId: "snap_1"}, networkPolicy: "deny-all", timeout: 20 * 60_000, persistent: false, resources: {vcpus: 2}}]);
  assert.deepEqual(fake.calls.writes, (await integrationUploads([], root)).files.map((file) => `${SANDBOX_ROOT}/${file}`));
  const detached = fake.calls.commands.filter((command) => command.detached);
  assert.equal(detached.length, 1);
  const {detached: _detached, timeoutMs, ...params} = detached[0];
  assert.deepEqual(params, integrationCommand(["font-readiness.test.mjs", "tutorial.test.mjs"]));
  assert.equal(timeoutMs, 15 * 60_000);
  assert.equal(report.chromium, "139.0.7258.5");
  assert.equal(report.node, "v22.20.0");
  assert.equal(report.snapshot.lockMatches, false);
  assert.match(report.warnings.join(), /another package-lock\.json/);
  assert.equal(fake.calls.stopped, 1);
  const [folder] = await readdir(join(root, ".studio-data"));
  const saved = JSON.parse(await readFile(join(root, ".studio-data", folder, "report.json"), "utf8"));
  assert.equal(saved.status, "passed");
  assert.equal(await readFile(join(root, ".studio-data", folder, "output.log"), "utf8"), PASSING);
});

test("a skipped test, leftover temporary folders, an open network, or another snapshot fail the run, and the Sandbox is still stopped", async (t) => {
  const root = await fixtureRoot(t);
  const skipped = fakeSandbox({testOutput: PASSING.replace("ℹ skipped 0", "ℹ skipped 3")});
  const skippedReport = await run(skipped, root);
  assert.equal(skippedReport.status, "failed");
  assert.equal(skippedReport.phase, "tests");
  assert.match(skippedReport.error, /3 skipped/);
  assert.equal(skipped.calls.stopped, 1);

  const left = fakeSandbox({leftovers: "sws-render-abc"});
  assert.match((await run(left, root)).error, /temporary folders left behind: sws-render-abc/);

  const open = fakeSandbox({outbound: ""});
  const openReport = await run(open, root);
  assert.equal(openReport.phase, "snapshot checks");
  assert.match(openReport.error, /reached the internet/);
  assert.deepEqual(open.calls.writes, []);
  assert.equal(open.calls.stopped, 1);

  const allowAll = fakeSandbox({metadata: {networkPolicy: "allow-all"}});
  assert.match((await run(allowAll, root)).error, /network policy/);
  assert.deepEqual(allowAll.calls.writes, []);

  const elsewhere = fakeSandbox({source: "snap_other"});
  assert.match((await run(elsewhere, root)).error, /did not start from the requested snapshot/);
  assert.deepEqual(elsewhere.calls.writes, []);
  assert.equal(elsewhere.calls.stopped, 1);
});

test("an identity for another project or an unbuilt dist/ stops before any Sandbox exists", async (t) => {
  const root = await fixtureRoot(t);
  const stranger = fakeSandbox();
  await assert.rejects(run(stranger, root, {...identity, project_id: "prj_other"}), /does not match/);
  const expiring = fakeSandbox();
  await assert.rejects(run(expiring, root, {...identity, exp: Math.floor(Date.now() / 1000) + 60}), /expires before/);
  await rm(join(root, "dist", "build-info.json"));
  const unbuilt = fakeSandbox();
  await assert.rejects(run(unbuilt, root), /npm run build:engine/);
  assert.deepEqual([stranger, expiring, unbuilt].map((fake) => fake.calls.create.length), [0, 0, 0]);
});
