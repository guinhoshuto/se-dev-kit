// A test file that starts a CLI `capture`, `record` or `render` sets its own render slot (#27). Under npm test the
// runner gives each suite one; run alone (node --test, npm run mutate), the CLI queues on the machine's real slot, and
// its jobs land in ~/.cache/render-slot.historico/, where they look like product jobs from se-dev-kit.
// The lesson is in README «Known pitfalls»; tests/unit/cut-loop.test.mjs shows the three lines.
import assert from "node:assert/strict";
import {readFile, readdir} from "node:fs/promises";
import {join, resolve} from "node:path";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "../..");
const CLI = "dist/cli/index.js";
// The array of arguments that starts the command: `[cli, "capture", …]` or `["render", root, …]`. A dry run counts too:
// should it ever take the slot, the machine's is the wrong one to find out with.
const STARTS_SLOT_COMMAND = /\[\s*(?:\w+\s*,\s*)?["'](?:capture|record|render)["']/;
// At column 0, so it runs before any test and every CLI the file starts inherits it.
const OWN_SLOT = /^Object\.assign\(process\.env, \{RENDER_SLOT_DIR: .+, MACHINE_CHECK: .+\}\);$/m;
// Their tests are about the slot: each passes a slot of its own in the `env` of the CLI it starts.
const SLOT_IN_EACH_ENV = ["tests/unit/machine-check.test.mjs", "tests/unit/render-slot.test.mjs"];

async function testSources() {
  const self = import.meta.filename.slice(ROOT.length + 1);
  const names = (await readdir(join(ROOT, "tests"), {recursive: true})).map((name) => join("tests", name));
  const files = names.filter((name) => /\.test\.(?:mjs|ts|tsx)$/.test(name) && name !== self).sort();
  return Promise.all(files.map(async (file) => ({file, source: await readFile(join(ROOT, file), "utf8")})));
}

test("the pattern finds the arguments that start a slot command, and not the same words elsewhere", () => {
  for (const source of ['execFile(node, [cli, "capture", root])', 'runCli(["record", root, "--scene", "hero"])', "const base = ['render', root];"]) {
    assert.match(source, STARTS_SLOT_COMMAND);
  }
  for (const source of ['.command("render")', 'join(out, "render")', 'productStep(env, log, "render")', '[join(out, "render"), join(out, "old")]', 'runCli(["validate", root])']) {
    assert.doesNotMatch(source, STARTS_SLOT_COMMAND);
  }
});

test("every test file that starts a CLI capture, record or render sets its own render slot", async () => {
  const starting = (await testSources()).filter(({source}) => source.includes(CLI) && STARTS_SLOT_COMMAND.test(source));
  const names = starting.map(({file}) => file);
  // The check above found them, so an empty list below means they all comply and not that it looked at nothing.
  for (const known of ["tests/integration/capture.test.mjs", "tests/unit/node-support.test.mjs", "tests/unit/render-disk.test.mjs", "tests/unit/render-recipes-cli.test.mjs", ...SLOT_IN_EACH_ENV]) {
    assert.ok(names.includes(known), `${known} was not found among the ${names.length} file(s) that start a slot command`);
  }
  const without = starting.filter(({file, source}) => !(SLOT_IN_EACH_ENV.includes(file) ? source.includes("RENDER_SLOT_DIR:") && source.includes("MACHINE_CHECK:") : OWN_SLOT.test(source)));
  assert.deepEqual(without.map(({file}) => file), [], "these test files start a CLI that takes the render slot and do not set their own: run alone, they queue on the machine's real slot and write to its history. Set RENDER_SLOT_DIR and MACHINE_CHECK atop the file, as tests/unit/cut-loop.test.mjs does");
});
