import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

// AGENTS.md and the vault's worktree hook give an agent one order: on 2026-10-28 an agent followed the raw
// `git worktree add -b` that AGENTS.md prescribed, and the hook's reminder to use novo_worktree.py became noise (#22).
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
