// The repo scripts npm runs, run through a link: Node resolves links for an ESM entry point's import.meta.url but not
// for argv[1], so a main guard that compares the two as they are exits 0 without doing anything (cut-loop.mjs did,
// through the skill link, on 2026-10-11). Each script runs a harmless command whose output only its main prints:
// nothing is killed, mutated, rendered, or fetched.
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtemp, rm, symlink} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import test from "node:test";

const SCRIPTS = fileURLToPath(new URL("../../scripts", import.meta.url));

/** A temporary folder holding `scripts`, a link to this checkout's scripts folder; it goes when the test ends. */
async function linkedScripts(t) {
  const root = await mkdtemp(join(tmpdir(), "sws-entry-link-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  await symlink(SCRIPTS, join(root, "scripts"), "dir");
  return join(root, "scripts");
}

function run(script, args, nodeFlags = []) {
  const env = {...process.env};
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [...nodeFlags, script, ...args], {encoding: "utf8", env, timeout: 30_000});
}

test("kill-stale, mutate and verify-hosted run through a link to the scripts folder print their usage for --help", async t => {
  const linked = await linkedScripts(t);
  const usage = {
    "kill-stale.mjs": /^Usage: npm run kill-stale \[-- --help\]\n/,
    "mutate.mjs": /^Usage: npm run mutate -- <file> --from <old> --to <new> --test <test-file>/,
    "verify-hosted.mjs": /^Usage: node scripts\/verify-hosted\.mjs --base-url <origin>/
  };
  for (const [name, expected] of Object.entries(usage)) {
    const result = run(join(linked, name), ["--help"]);
    assert.equal(result.status, 0, `${name} --help: ${result.stderr}`);
    assert.match(result.stdout, expected, `${name} --help through the link`);
  }
});

test("run-tests run through a link to the scripts folder refuses an unknown suite before it writes a log", async t => {
  const linked = await linkedScripts(t);
  const result = run(join(linked, "run-tests.mjs"), ["no-such-suite"]);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /^Unknown suite no-such-suite\. Suites: unit, integration, web, web:browser\.$/m);
  assert.equal(result.stdout, "", "it stopped before naming a log folder");
});

test("a script started with --preserve-symlinks-main, whose import.meta.url keeps the link, still runs its main", async t => {
  const linked = await linkedScripts(t);
  const result = run(join(linked, "mutate.mjs"), ["--help"], ["--preserve-symlinks-main"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Usage: npm run mutate -- <file>/);
});
