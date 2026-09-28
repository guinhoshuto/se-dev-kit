import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import test from "node:test";

import {SUPPORTED_NODE, assertSupportedNode, satisfiesNodeRange} from "../../dist/shared/node-support.js";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../../dist/cli/index.js", import.meta.url));
const exampleRoot = fileURLToPath(new URL("../../examples/basic-chat/", import.meta.url));

test("the supported range is package.json engines: Node 22 from 22.20, and Node 24", async () => {
  const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  assert.equal(SUPPORTED_NODE, pkg.engines.node);
  for (const version of ["22.20.0", "22.99.1", "24.0.0", "24.21.0", "v24.21.0"]) assert.equal(satisfiesNodeRange(version), true, version);
  for (const version of ["20.19.0", "22.19.9", "23.0.0", "23.11.0", "25.0.0", "26.9.0"]) assert.equal(satisfiesNodeRange(version), false, version);
  assert.throws(() => satisfiesNodeRange("24.0.0", "^24"), /Unsupported engines comparator/);
});

test("renders refuse an unsupported Node.js with NODE_UNSUPPORTED unless explicitly allowed", () => {
  assert.throws(() => assertSupportedNode(false, "26.9.0"), (error) => {
    assert.equal(error.code, "NODE_UNSUPPORTED");
    assert.match(error.message, /Node\.js 26\.9\.0 is outside this Studio's supported range/);
    assert.match(error.hint, /Node 24/);
    assert.match(error.hint, /--allow-unsupported-node/);
    return true;
  });
  assert.doesNotThrow(() => assertSupportedNode(true, "26.9.0"));
  assert.doesNotThrow(() => assertSupportedNode(false, "24.21.0"));
});

// The CLI wiring needs a Node.js outside the range; on the Studio's Mac that is Homebrew's default node.
async function unsupportedNode() {
  for (const candidate of [process.env.SE_WIDGET_STUDIO_UNSUPPORTED_NODE, "/opt/homebrew/opt/node/bin/node", "/usr/local/bin/node"]) {
    if (!candidate) continue;
    try {
      const {stdout} = await execFileAsync(candidate, ["-p", "process.versions.node"]);
      if (!satisfiesNodeRange(stdout.trim())) return candidate;
    } catch {
      // Not installed.
    }
  }
  return undefined;
}

test("capture refuses an unsupported Node.js before any work, the flag lets it through, and a dry run never asks", {timeout: 60_000}, async (t) => {
  const node = await unsupportedNode();
  if (!node) {
    t.skip("No Node.js outside the supported range is installed to run the CLI with.");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "sws-node-policy-"));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const run = async (args) => {
    try {
      const {stdout, stderr} = await execFileAsync(node, [cliPath, ...args]);
      return {code: 0, stdout, stderr};
    } catch (error) {
      return {code: error.code, stdout: error.stdout, stderr: error.stderr};
    }
  };
  const base = ["capture", exampleRoot, "--output", join(directory, "out"), "--json", "--browser-path", join(directory, "missing-chrome")];
  const refused = await run(base);
  assert.equal(refused.code, 2);
  assert.equal(JSON.parse(refused.stderr).code, "NODE_UNSUPPORTED", refused.stderr);
  const allowed = await run([...base, "--allow-unsupported-node"]);
  assert.equal(JSON.parse(allowed.stderr).code, "BROWSER_NOT_FOUND", allowed.stderr);
  const dryRun = await run(["render", exampleRoot, "--recipe", "listing-media", "--dry-run", "--json"]);
  assert.equal(dryRun.code, 0, dryRun.stderr);
});
