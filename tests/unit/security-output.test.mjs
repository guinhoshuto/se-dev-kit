import assert from "node:assert/strict";
import {mkdtemp, mkdir, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {realpath} from "node:fs/promises";
import test from "node:test";

import {atomicWriteFile, preflightOutputTargets} from "../../dist/capture/output.js";
import {assertSafeId, slugify} from "../../dist/shared/ids.js";
import {assertSafeOutputRoot} from "../../dist/shared/paths.js";

async function temporaryDirectory(t, prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, {recursive: true, force: true}));
  return directory;
}

test("safe IDs accept canonical slugs and reject path-like or ambiguous values", () => {
  for (const value of ["hero", "hero-2", "navy-stage", "a1-b2-c3"]) {
    assert.equal(assertSafeId(value), value);
  }
  for (const value of ["", "../hero", "hero/large", "hero\\large", ".hidden", "Hero", "hero_name", "hero--large", "hero."]) {
    assert.throws(() => assertSafeId(value), (error) => error?.code === "INVALID_ID");
  }
  assert.equal(slugify("  Café Hero  "), "cafe-hero");
});

test("the overwrite guard requires force and force preserves unrelated output files", async (t) => {
  const root = await temporaryDirectory(t, "sws-output-");
  const outputRoot = join(root, "output");
  const targetDirectory = join(outputRoot, "listing-media");
  const target = join(targetDirectory, "hero.png");
  const sentinel = join(outputRoot, "do-not-delete.txt");
  await mkdir(targetDirectory, {recursive: true});
  await writeFile(target, "old artifact");
  await writeFile(sentinel, "unrelated user file");

  await assert.rejects(
    preflightOutputTargets(outputRoot, [target], false),
    (error) => error?.code === "OUTPUT_EXISTS" && /--force/.test(error.hint ?? "")
  );
  assert.equal(await readFile(target, "utf8"), "old artifact");
  assert.equal(await readFile(sentinel, "utf8"), "unrelated user file");

  await preflightOutputTargets(outputRoot, [target], true);
  assert.equal(await readFile(target, "utf8"), "old artifact", "preflight must not delete the planned target");
  await atomicWriteFile(outputRoot, target, "new artifact");

  assert.equal(await readFile(target, "utf8"), "new artifact");
  assert.equal(await readFile(sentinel, "utf8"), "unrelated user file");
});

test("an output root cannot be an ancestor of a protected workspace", async (t) => {
  const root = await temporaryDirectory(t, "sws-protected-output-");
  const workspace = join(root, "workspace", "widget");
  await mkdir(workspace, {recursive: true});

  await assert.rejects(
    assertSafeOutputRoot(root, [workspace]),
    (error) => error?.code === "UNSAFE_OUTPUT" && /ancestor/.test(error.message)
  );
  const canonicalWorkspace = await realpath(workspace);
  assert.equal(
    await assertSafeOutputRoot(join(workspace, ".se-widget-studio", "output"), [workspace]),
    resolve(canonicalWorkspace, ".se-widget-studio", "output")
  );
});
