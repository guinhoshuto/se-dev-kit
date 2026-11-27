import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

// Step 6 of an Orca session marks its workspace completed. On 2026-11-26 the session of #59 ran the `orca worktree
// set`, read only the last lines of its text reply, which do not carry the status, and told the owner the workspace
// was completed without reading it back (#62). The step now reads the status back and names it.
const agents = readFileSync(resolve(import.meta.dirname, "../../AGENTS.md"), "utf8");
const step = agents.split("\n").find((line) => line.startsWith("6. Started by Orca:"));

// The shape `orca worktree current --json` printed on 2026-11-27, trimmed to the keys around the status.
const currentReply = {
  id: "00000000-0000-0000-0000-000000000000",
  ok: true,
  result: {
    worktree: {
      id: "repo-id::/path/to/worktree",
      path: "/path/to/worktree",
      branch: "refs/heads/wip/task",
      displayName: "Task",
      linkedIssue: 62,
      workspaceStatus: "completed",
    },
  },
};

test("AGENTS.md reads the Orca workspace status back after marking it completed", () => {
  assert.ok(step, "AGENTS.md has no step starting with `6. Started by Orca:`");
  const set = step.indexOf("`orca worktree set --worktree current --workspace-status completed`");
  assert.ok(set >= 0, "step 6 does not mark the workspace completed");
  const readBack = step.match(/`orca worktree current --json \| jq -r (\.[A-Za-z.]+)`/);
  assert.ok(readBack, "step 6 does not read the status back with `orca worktree current --json | jq -r <path>`");
  assert.ok(readBack.index > set, "step 6 reads the status back before it marks the workspace");
  const value = readBack[1]
    .split(".")
    .slice(1)
    .reduce((node, key) => (node === undefined ? undefined : node[key]), currentReply);
  assert.equal(value, "completed", `the jq path ${readBack[1]} does not reach workspaceStatus`);
});

test("AGENTS.md makes the last answer name the status it read back, or say it could not confirm it", () => {
  assert.ok(step.includes("The last answer names the status it read back;"), "the last answer does not name the status");
  assert.ok(
    step.includes(
      "when the command fails or prints anything but `completed`, it says the workspace could not be confirmed completed"
    ),
    "the last answer does not say when the workspace could not be confirmed"
  );
});
