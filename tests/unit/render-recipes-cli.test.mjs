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
  assert.deepEqual(JSON.parse(all.stdout).map((result) => result.plan.recipe).sort(), ["etsy-listing-images", "etsy-listing-video", "listing-loop-video", "listing-media", "listing-tutorial", "tutorial-setup"]);

  const both = await runCli(["render", exampleRoot, "--all", "--recipe", "listing-media", "--dry-run", "--json"]);
  assert.equal(JSON.parse(both.stderr).code, "RECIPE_SELECTION", both.stderr);
  const none = await runCli(["render", exampleRoot, "--dry-run", "--json"]);
  assert.equal(JSON.parse(none.stderr).code, "RECIPE_SELECTION", none.stderr);
  const unknown = await runCli(["render", exampleRoot, "--recipe", "listing-media", "--recipe", "missing", "--dry-run", "--json"]);
  assert.equal(JSON.parse(unknown.stderr).code, "RECIPE_NOT_FOUND", unknown.stderr);
});

test("render --fps and --duration replace the recipe's video timing for the run, validated as a recipe", {timeout: 60_000}, async () => {
  const base = JSON.parse((await runCli(["render", exampleRoot, "--recipe", "listing-tutorial", "--dry-run", "--json"])).stdout);
  const fast = await runCli(["render", exampleRoot, "--recipe", "listing-tutorial", "--fps", "5", "--dry-run", "--json"]);
  assert.equal(fast.code, 0, fast.stderr);
  assert.equal(JSON.parse(fast.stdout).plan.totalFrames, 75, "15 s at 5 fps");
  assert.notEqual(base.plan.totalFrames, 75);
  const shorter = await runCli(["render", exampleRoot, "--recipe", "listing-tutorial", "--fps", "5", "--duration", "14000", "--dry-run", "--json"]);
  assert.equal(JSON.parse(shorter.stdout).plan.totalFrames, 70, "14 s at 5 fps");
  // The overridden recipe still meets its marketplace preset.
  const tooLong = await runCli(["render", exampleRoot, "--recipe", "listing-tutorial", "--duration", "20000", "--dry-run", "--json"]);
  assert.equal(JSON.parse(tooLong.stderr).code, "MARKETPLACE_RECIPE_INVALID", tooLong.stderr);

  const zero = await runCli(["render", exampleRoot, "--recipe", "listing-tutorial", "--fps", "0", "--dry-run", "--json"]);
  assert.equal(JSON.parse(zero.stderr).code, "VIDEO_OVERRIDE_INVALID", zero.stderr);
  const fraction = await runCli(["render", exampleRoot, "--recipe", "listing-tutorial", "--fps", "2.5", "--dry-run", "--json"]);
  assert.equal(JSON.parse(fraction.stderr).code, "VIDEO_OVERRIDE_INVALID", fraction.stderr);
  const noVideo = await runCli(["render", exampleRoot, "--recipe", "etsy-listing-images", "--fps", "5", "--dry-run", "--json"]);
  assert.equal(JSON.parse(noVideo.stderr).code, "VIDEO_OVERRIDE_INVALID", noVideo.stderr);
  // A shorter video than the tutorial is refused with the flag in the hint.
  const short = await runCli(["render", exampleRoot, "--recipe", "listing-tutorial", "--duration", "3000", "--dry-run", "--json"]);
  const shortError = JSON.parse(short.stderr);
  assert.equal(shortError.code, "TUTORIAL_TOO_LONG", short.stderr);
  assert.match(shortError.hint, /render --duration/);
});

test("render --plan-only refuses --dry-run and a recipe without a tutorial video before it waits for the machine", {timeout: 60_000}, async () => {
  const both = await runCli(["render", exampleRoot, "--recipe", "listing-tutorial", "--plan-only", "--dry-run", "--json"]);
  assert.equal(JSON.parse(both.stderr).code, "RENDER_MODE", both.stderr);
  // A check after the slot would answer with the busy machine (--no-wait) or the missing browser instead.
  const stage = await runCli(["render", exampleRoot, "--recipe", "listing-tutorial", "--recipe", "listing-media", "--plan-only", "--no-wait", "--browser-path", "/nonexistent/chrome", "--json"]);
  const error = JSON.parse(stage.stderr);
  assert.equal(error.code, "PLAN_ONLY_NEEDS_TUTORIAL", stage.stderr);
  assert.match(error.detail, /"listing-media"/);
});
