import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../../dist/cli/index.js", import.meta.url));
const exampleRoot = fileURLToPath(new URL("../../examples/basic-chat/", import.meta.url));

async function runCli(args) {
  try {
    const {stdout, stderr} = await execFileAsync(process.execPath, [cliPath, ...args], {maxBuffer: 64 * 1024 * 1024});
    return {code: 0, stdout, stderr};
  } catch (error) {
    return {code: error.code, stdout: error.stdout, stderr: error.stderr};
  }
}

test("render takes several recipes in order, or --all, and keeps a single recipe's output shape", {timeout: 60_000}, async () => {
  const single = await runCli(["render", exampleRoot, "--recipe", "listing-media", "--dry-run", "--json"]);
  assert.equal(single.code, 0, single.stderr);
  assert.equal(JSON.parse(single.stdout).status, "dry-run", "one recipe still prints one result object");

  const two = await runCli(["render", exampleRoot, "--recipe", "listing-media", "--recipe", "etsy-listing-images", "--dry-run", "--json"]);
  assert.equal(two.code, 0, two.stderr);
  assert.deepEqual(JSON.parse(two.stdout).map((result) => result.plan.recipe), ["listing-media", "etsy-listing-images"]);

  const all = await runCli(["render", exampleRoot, "--all", "--dry-run", "--json"]);
  assert.equal(all.code, 0, all.stderr);
  assert.deepEqual(JSON.parse(all.stdout).map((result) => result.plan.recipe).sort(), ["etsy-listing-images", "etsy-listing-video", "listing-media", "tutorial-setup"]);

  const both = await runCli(["render", exampleRoot, "--all", "--recipe", "listing-media", "--dry-run", "--json"]);
  assert.equal(JSON.parse(both.stderr).code, "RECIPE_SELECTION", both.stderr);
  const none = await runCli(["render", exampleRoot, "--dry-run", "--json"]);
  assert.equal(JSON.parse(none.stderr).code, "RECIPE_SELECTION", none.stderr);
  const unknown = await runCli(["render", exampleRoot, "--recipe", "listing-media", "--recipe", "missing", "--dry-run", "--json"]);
  assert.equal(JSON.parse(unknown.stderr).code, "RECIPE_NOT_FOUND", unknown.stderr);
});
