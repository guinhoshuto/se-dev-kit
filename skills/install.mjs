#!/usr/bin/env node

import {
  cp,
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir, platform } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const skillsRoot = dirname(fileURLToPath(import.meta.url));
const skillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function help() {
  return `Install the skills bundled with SE Widget Studio.

Usage:
  node skills/install.mjs [options]

Options:
  --list                 List bundled skills without installing them
  --skill <name>         Install one skill; repeat to select more than one
  --skills-dir <path>    Install into an explicit absolute skills directory
  --link                 Create development links instead of portable copies
  -h, --help             Show this help

By default, every bundled skill is copied to:
  $CODEX_HOME/skills, or ~/.codex/skills when CODEX_HOME is unset

Existing targets are never replaced. Move or remove an existing skill yourself
after reviewing it, then run this installer again.
`;
}

function parseArgs(argv) {
  const options = {
    help: false,
    link: false,
    list: false,
    selectedSkills: [],
    skillsDir: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "-h" || argument === "--help") {
      options.help = true;
      continue;
    }
    if (argument === "--link") {
      options.link = true;
      continue;
    }
    if (argument === "--list") {
      options.list = true;
      continue;
    }
    if (argument === "--skill") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--skill requires a skill name.");
      }
      options.selectedSkills.push(value);
      index += 1;
      continue;
    }
    if (argument === "--skills-dir") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--skills-dir requires an absolute path.");
      }
      if (options.skillsDir) {
        throw new Error("--skills-dir may only be provided once.");
      }
      options.skillsDir = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown option: ${argument}`);
  }

  return options;
}

function isContained(parent, child) {
  const pathFromParent = relative(parent, child);
  return pathFromParent !== "" && !pathFromParent.startsWith("..") && !isAbsolute(pathFromParent);
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function validateSkillTree(path) {
  const entries = await readdir(path, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = join(path, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Bundled skill contains an unsupported symbolic link: ${entryPath}`);
    }
    if (entry.isDirectory()) {
      await validateSkillTree(entryPath);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Bundled skill contains an unsupported file type: ${entryPath}`);
    }
  }
}

async function discoverSkills() {
  const entries = await readdir(skillsRoot, { withFileTypes: true });
  const names = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !skillNamePattern.test(entry.name)) {
      continue;
    }

    const skillFile = join(skillsRoot, entry.name, "SKILL.md");
    try {
      const metadata = await stat(skillFile);
      if (metadata.isFile()) {
        names.push(entry.name);
      }
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  return names.sort();
}

function resolveRequestedSkills(availableSkills, requestedSkills) {
  if (requestedSkills.length === 0) {
    return availableSkills;
  }

  const uniqueRequests = [...new Set(requestedSkills)];
  for (const name of uniqueRequests) {
    if (!skillNamePattern.test(name)) {
      throw new Error(`Invalid skill name: ${name}`);
    }
    if (!availableSkills.includes(name)) {
      throw new Error(`Bundled skill not found: ${name}`);
    }
  }

  return uniqueRequests;
}

function defaultSkillsDirectory() {
  const codexHome = process.env.CODEX_HOME;
  if (codexHome) {
    if (!isAbsolute(codexHome)) {
      throw new Error("CODEX_HOME must be an absolute path.");
    }
    return join(codexHome, "skills");
  }
  return join(homedir(), ".codex", "skills");
}

async function installSkills({ link, selectedSkills, skillsDir }) {
  if (!isAbsolute(skillsDir)) {
    throw new Error("The skills directory must be an absolute path.");
  }

  await mkdir(skillsDir, { mode: 0o700, recursive: true });
  const canonicalSkillsDir = await realpath(skillsDir);
  const plans = [];

  for (const name of selectedSkills) {
    const source = await realpath(join(skillsRoot, name));
    if (!isContained(skillsRoot, source)) {
      throw new Error(`Bundled skill resolves outside the repository skills directory: ${name}`);
    }
    await validateSkillTree(source);

    const target = resolve(canonicalSkillsDir, name);
    if (!isContained(canonicalSkillsDir, target)) {
      throw new Error(`Install target resolves outside the selected skills directory: ${name}`);
    }
    if (await pathExists(target)) {
      throw new Error(`Install target already exists: ${target}`);
    }

    plans.push({ name, source, target });
  }

  const staged = [];
  const installed = [];

  try {
    for (const plan of plans) {
      const stagingPath = join(
        canonicalSkillsDir,
        `.se-widget-studio-install-${plan.name}-${randomUUID()}`,
      );

      if (link) {
        await symlink(plan.source, stagingPath, platform() === "win32" ? "junction" : "dir");
      } else {
        await cp(plan.source, stagingPath, {
          errorOnExist: true,
          force: false,
          preserveTimestamps: true,
          recursive: true,
        });
      }

      staged.push(stagingPath);
      await rename(stagingPath, plan.target);
      staged.pop();
      installed.push(plan.target);
    }
  } catch (error) {
    await Promise.allSettled([
      ...staged.map((path) => rm(path, { force: true, recursive: true })),
      ...installed.map((path) => rm(path, { force: true, recursive: true })),
    ]);
    throw error;
  }

  return plans.map(({ name, target }) => ({ name, path: target }));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(help());
    return;
  }

  const availableSkills = await discoverSkills();
  if (availableSkills.length === 0) {
    throw new Error("No bundled skills were found.");
  }

  if (options.list) {
    process.stdout.write(`${JSON.stringify({ skills: availableSkills }, null, 2)}\n`);
    return;
  }

  const selectedSkills = resolveRequestedSkills(availableSkills, options.selectedSkills);
  const skillsDir = options.skillsDir ?? defaultSkillsDirectory();
  const installedSkills = await installSkills({
    link: options.link,
    selectedSkills,
    skillsDir,
  });

  process.stdout.write(
    `${JSON.stringify(
      {
        mode: options.link ? "link" : "copy",
        skills: installedSkills,
        skillsDir: await realpath(skillsDir),
        status: "installed",
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Skill installation failed: ${message}\n`);
  process.exitCode = 1;
});
