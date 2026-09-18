import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../..");
const installer = join(repositoryRoot, "skills/install.mjs");
const sourceSkill = join(repositoryRoot, "skills/se-widget-studio");

test("the skill installer lists the complete bundled skill", async () => {
  const { stdout } = await execFileAsync(process.execPath, [installer, "--list"]);
  const result = JSON.parse(stdout) as { skills: string[] };

  assert.deepEqual(result.skills, ["se-widget-studio"]);

  const { stdout: help } = await execFileAsync(process.execPath, [installer, "--help"]);
  assert.match(help, /portable copies/);
  assert.match(help, /Existing targets are never replaced/);
});

test("the skill installer creates a portable copy and refuses replacement", async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "se-widget-skill-copy-"));
  context.after(() => rm(temporaryRoot, { force: true, recursive: true }));
  const destination = join(temporaryRoot, "skills");

  const { stdout } = await execFileAsync(process.execPath, [
    installer,
    "--skill",
    "se-widget-studio",
    "--skills-dir",
    destination,
  ]);
  const result = JSON.parse(stdout) as {
    mode: string;
    status: string;
    skills: Array<{ name: string; path: string }>;
  };
  const installedSkill = join(destination, "se-widget-studio");
  const canonicalInstalledSkill = await realpath(installedSkill);

  assert.equal(result.status, "installed");
  assert.equal(result.mode, "copy");
  assert.deepEqual(result.skills, [{ name: "se-widget-studio", path: canonicalInstalledSkill }]);
  assert.equal(
    await readFile(join(installedSkill, "SKILL.md"), "utf8"),
    await readFile(join(sourceSkill, "SKILL.md"), "utf8"),
  );
  assert.notEqual((await stat(join(installedSkill, "scripts/studio-client.mjs"))).mode & 0o111, 0);

  await assert.rejects(
    execFileAsync(process.execPath, [installer, "--skills-dir", destination]),
    (error: unknown) => {
      assert.equal(typeof error, "object");
      assert.match(String((error as { stderr?: string }).stderr), /Install target already exists/);
      return true;
    },
  );
});

test("the skill installer can create an explicit development link", async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "se-widget-skill-link-"));
  context.after(() => rm(temporaryRoot, { force: true, recursive: true }));
  const destination = join(temporaryRoot, "skills");

  await execFileAsync(process.execPath, [
    installer,
    "--link",
    "--skills-dir",
    destination,
  ]);

  const installedSkill = join(destination, "se-widget-studio");
  assert.equal((await lstat(installedSkill)).isSymbolicLink(), true);
  assert.equal(await realpath(installedSkill), await realpath(sourceSkill));
});
