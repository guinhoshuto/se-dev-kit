import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

// Every issue ends with `Tracker: <ID>` so a session on it knows which vault tracker item to close. #20, opened
// on 2026-10-28 outside a /melhorias round, was born without the line: AGENTS.md said what the line means but not
// what a session that opens an issue itself must do (#25).
const agents = readFileSync(resolve(import.meta.dirname, "../../AGENTS.md"), "utf8");

test("AGENTS.md makes an issue opened outside a /melhorias round end with Tracker: <ID> or Tracker: none", () => {
  assert.match(agents, /opened outside a round of the vault's \/melhorias ends, like the round's, with `Tracker: <ID>`/);
  assert.ok(
    agents.includes("`python3 ~/obsidian/.claude/skills/melhorias/scripts/aplicar.py --novo-item <AREA>` (it writes nothing)"),
    "AGENTS.md does not name the aplicar.py --novo-item command that gives the next ID"
  );
  assert.ok(
    agents.includes('`python3 ~/obsidian/.claude/skills/fechar/linhas.py --nova "<text>"`'),
    "AGENTS.md does not name the linhas.py --nova command that asks the /fechar to create the item"
  );
  assert.ok(agents.includes("`Tracker: none — <why>`"), "AGENTS.md does not name the Tracker: none — <why> form");
});
