// A chain of the harness that takes the render slot step by step (HAR-301): each round is a
// `render-slot hold --ceder`, as each round of the vault's mutar_copia.py takes the slot.
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {readdir} from "node:fs/promises";
import {setTimeout as sleep} from "node:timers/promises";

/** One round, run by the render-slot module at `script`: `holding` resolves with the moment it says it holds the slot; SIGTERM ends it. */
export function chainRound(t, {script, label, env, cwd}) {
  const round = spawn(process.execPath, [script, "hold", "--rotulo", label, "--max", "1", "--ceder"], {cwd, env, stdio: ["ignore", "pipe", "ignore"]});
  t.after(() => round.kill("SIGKILL"));
  let said = "";
  const holding = new Promise((resolve) => round.stdout.on("data", (chunk) => {
    said += chunk;
    if (said.includes("Holding the render slot")) resolve(Date.now());
  }));
  return {round, holding};
}

/** Waits until `count` tickets wait in the queue of the slot at `dir`. */
export async function queueHolds(dir, count) {
  for (let tries = 0; tries < 300; tries += 1) {
    const tickets = (await readdir(`${dir}.queue`).catch(() => [])).filter((name) => /^\d{15}-\d{7}\.json$/.test(name));
    if (tickets.length >= count) return;
    await sleep(50);
  }
  assert.fail(`The queue of ${dir} never held ${count} ticket(s).`);
}
