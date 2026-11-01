import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

// AGENTS.md and the vault's worktree hook give an agent one order: on 2026-10-28 an agent followed the raw
// `git worktree add -b` that AGENTS.md prescribed, and the hook's reminder to use novo_worktree.py became noise (#22).
// The removal is the same: the hook denies the raw removal, so an agent that followed the repo stopped there (#24).
const agents = readFileSync(resolve(import.meta.dirname, "../../AGENTS.md"), "utf8");

test("AGENTS.md creates the task worktree through novo_worktree.py, never a raw git worktree add", () => {
  assert.doesNotMatch(agents, /worktree add/);
  assert.ok(
    agents.includes(
      "`python3 ~/obsidian/AI/scripts/novo_worktree.py ~/dev/firulas/se-dev-kit <task> --base main --node-modules`"
    ),
    "AGENTS.md does not name the novo_worktree.py command"
  );
});

test("AGENTS.md removes the task worktree through remover_worktree.py, never a raw git or orca removal", () => {
  assert.doesNotMatch(agents, /worktree remove|worktree rm\b/);
  assert.ok(
    agents.includes(
      "`python3 ~/obsidian/AI/scripts/remover_worktree.py ~/dev/firulas/se-dev-kit/.claude/worktrees/<task>`"
    ),
    "AGENTS.md does not name the remover_worktree.py command"
  );
});
