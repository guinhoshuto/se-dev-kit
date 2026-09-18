# Install the bundled skills

This repository contains the complete `se-widget-studio` skill, including its hosted client, operational references, and agent metadata. Install the whole skill directory; `SKILL.md` alone is not enough.

## Install on another machine

Clone the repository and select a reviewed tag or commit before installing:

```bash
git clone https://github.com/guinhoshuto/se-dev-kit.git
cd se-dev-kit
git checkout <reviewed-tag-or-commit>
node skills/install.mjs --list
node skills/install.mjs
```

The default command makes a portable copy in `$CODEX_HOME/skills` or `~/.codex/skills`. It does not install npm dependencies and does not modify the cloned source files. Start a new Codex task after installation so the skill catalog is refreshed.

The installer refuses to replace an existing skill. Review and move or remove the existing target yourself before installing a newer revision.

## Options

Install only this skill:

```bash
node skills/install.mjs --skill se-widget-studio
```

Install into an explicit agent skills directory:

```bash
node skills/install.mjs --skills-dir /absolute/path/to/skills
```

For development on the same machine, create a link instead of a portable copy:

```bash
node skills/install.mjs --link
```

Linked installations stop working if the repository is moved or removed. Use the default copy mode for another machine.

## Verify

Confirm that the installed entry point and hosted client are present:

```bash
test -f "${CODEX_HOME:-$HOME/.codex}/skills/se-widget-studio/SKILL.md"
test -x "${CODEX_HOME:-$HOME/.codex}/skills/se-widget-studio/scripts/studio-client.mjs"
```

The skill uses the deployed Studio for hosted workflows and the repository package for local workflows. It never embeds consumer widget code in the skill itself.
