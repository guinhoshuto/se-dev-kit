import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

// Agents load the skill through the global link ~/.claude/skills/se-widget-studio, where `<skill>/../..` is
// ~/.claude, not the Studio checkout: node and the shell's `cd` drop the `..` from the text. Sessions' `validate`
// failed with "Cannot find module", and on 2026-10-20 a `cd` there broke `git status`, the BUILD_ID check, and
// `dist`, until they ran realpath (SDK-52). Every command the skill gives for the checkout runs here through such
// a link and has to print the checkout.
const checkout = realpathSync(resolve(import.meta.dirname, "../.."));
const skill = join(checkout, "skills/se-widget-studio");
const PATH_UP = /\S\/\.\.\/\.\./; // a path built two levels above something, such as `<skill>/../..`

const spans = (file) =>
  [...readFileSync(join(skill, file), "utf8").replace(/^```[\s\S]*?^```/gm, "").matchAll(/`([^`\n]+)`/g)].map(
    ([, code]) => code
  );

const throughLink = (run) => {
  const root = mkdtempSync(join(tmpdir(), "sws-skill-link-"));
  try {
    mkdirSync(join(root, "skills"));
    const link = join(root, "skills/se-widget-studio");
    symlinkSync(skill, link);
    assert.equal(resolve(link, "../.."), root, "the link does not reproduce the textual `../..`");
    return run(link);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
};

const sh = (script, link) => execFileSync("/bin/sh", ["-c", script.replaceAll("<skill>", '"$1"'), "sh", link], { encoding: "utf8" });

test("every checkout command of SKILL.md finds the checkout through a linked skill", () => {
  const commands = spans("SKILL.md").filter((code) => PATH_UP.test(code));
  assert.ok(commands.length >= 3, `only ${commands.length} checkout commands in SKILL.md`);
  throughLink((link) => {
    for (const command of commands) {
      assert.equal(sh(command, link).trim(), checkout, `\`${command}\` does not print the checkout`);
    }
  });
});

const definitions = () => spans("references/studio-workflow.md").filter((code) => /^(SKILL|STUDIO)_DIR=/.test(code));

test("studio-workflow.md resolves SKILL_DIR and STUDIO_DIR through a linked skill", () => {
  assert.deepEqual(
    definitions().map((code) => code.split("=")[0]),
    ["SKILL_DIR", "STUDIO_DIR"]
  );
  throughLink((link) => {
    const printed = sh([...definitions(), 'printf "%s\\n" "$SKILL_DIR" "$STUDIO_DIR"'].join("\n"), link);
    assert.deepEqual(printed.trim().split("\n"), [skill, checkout]);
  });
});

test("no reference builds a path above the skill outside those definitions", () => {
  const allowed = new Set(definitions());
  for (const name of readdirSync(join(skill, "references")).filter((entry) => entry.endsWith(".md"))) {
    for (const code of spans(`references/${name}`).filter((code) => PATH_UP.test(code))) {
      assert.ok(allowed.has(code), `references/${name}: \`${code}\` is a textual path above the skill; use $STUDIO_DIR or <checkout>`);
    }
  }
});
